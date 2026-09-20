import { Hono } from 'hono';
import type { Context } from 'hono';
import type { BundleRow, BundleItemRow, BundleItemDraft } from '../db/repositories';
import type { AppEnv } from '../types/env.d';
import { toMinorUnits, toMoney, type MoneyV2 } from '../lib/money';
import {
  writeComposition,
  clearComposition,
  mergeConfigEntry,
  upsertMergeConfig,
  removeMergeConfig,
  type BundleItemLike,
} from '../lib/bundleMetafields';
import { adminGraphql } from '../lib/graphqlAdmin';
import { requireShopDomain } from '../lib/shopDomain';
import { resolveVariants, variantDisplayName, VARIANT_GID, MAX_VARIANT_IDS } from '../lib/variantResolver';
import { ensureCartTransform } from '../lib/cartTransformRegistration';
import { removeCartTransformMetafieldDefinitions, getMetafieldSetupStatus } from '../lib/metafieldDefinitions';

export const bundleRoutes = new Hono<AppEnv>();

type Row = BundleRow;

/**
 * What a client posts per item.
 *
 * `price` is accepted but NOT trusted — see `verifyItems`. `priceAdjustment`
 * arriving on a request body is in MAJOR units (dollars), unlike the stored
 * `bundle_item.priceAdjustment`, which is minor units like every other money
 * column.
 */
interface BundleItemInput {
  variantId: string;
  qty: number;
  priceAdjustment?: number;
  titleOverride?: string;
  /** Ignored — the editor sends it for its live preview; the server re-resolves. */
  price?: number;
}

interface BundleInput {
  name: string;
  operation: 'merge' | 'expand' | 'update';
  items: BundleItemInput[];
  parentVariantId?: string;
  price?: number; // dollars (major units)
  status?: 'Active' | 'Scheduled' | 'Ended' | 'Draft';
}

interface BundleItemDto {
  variantId: string;
  name: string;
  qty: number;
  price: MoneyV2;
  priceAdjustment?: MoneyV2;
  titleOverride?: string;
}

interface BundleDto {
  id: string;
  name: string;
  operation: 'merge' | 'expand' | 'update';
  items: BundleItemDto[];
  parentVariantId?: string;
  price: MoneyV2 | null;
  sumOfItems: MoneyV2 | null;
  status: 'Active' | 'Scheduled' | 'Ended' | 'Draft';
  metafieldState: 'NotYet' | 'Written' | 'Cleared';
  metafieldGid?: string;
  updated: string;
}

// Copied from src/routes/discounts.ts — see that file for the canonical version.
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'Just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The caller's shop currency. Every money value crossing this boundary needs
 * it, and a shop row without one is a data-integrity problem rather than a
 * reason to guess USD — `toMoney` would silently store JPY off by 100.
 */
async function shopCurrency(c: Context<AppEnv>): Promise<string> {
  const shop = await c.get('repos').shops.findById(c.get('shopId'));
  if (!shop?.currency) {
    throw new Error(`[bundles] shop ${c.get('shopId')} has no currency on its row`);
  }
  return shop.currency;
}

/** Minor units -> a plain JS number of major units, for numeric validation/config building. */
function toMajorNumber(minorUnits: number, currency: string): number {
  return Number(toMoney(minorUnits, currency)!.amount);
}

function toItemDto(row: BundleItemRow, currency: string): BundleItemDto {
  return {
    variantId: row.variantId,
    name: row.name,
    qty: row.qty,
    price: toMoney(row.price, currency)!,
    ...(row.priceAdjustment !== null
      ? { priceAdjustment: toMoney(row.priceAdjustment, currency)! }
      : {}),
    ...(row.titleOverride ? { titleOverride: row.titleOverride } : {}),
  };
}

function toDto(
  row: Row,
  items: BundleItemRow[],
  sumOfItems: number | null,
  currency: string,
): BundleDto {
  return {
    id: row.id,
    name: row.name,
    operation: row.operation,
    items: items.map((item) => toItemDto(item, currency)),
    ...(row.parentVariantId ? { parentVariantId: row.parentVariantId } : {}),
    price: toMoney(row.price, currency),
    sumOfItems: toMoney(sumOfItems, currency),
    status: row.status,
    metafieldState: row.metafieldState,
    ...(row.metafieldGid ? { metafieldGid: row.metafieldGid } : {}),
    updated: relativeTime(row.updatedAt),
  };
}

/** Lets `verifyItems` fail with a status without every caller re-checking. */
class HttpError extends Error {
  constructor(
    public readonly status: 400 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Re-resolves every item's price and name from Shopify in ONE Admin call, and
 * returns the rows to store.
 *
 * Client-sent prices are discarded. They exist so the editor can show a running
 * total while the merchant picks; they are not a source of truth, and for an
 * `expand` bundle they would flow straight into the `composition_v2` metafield
 * the Rust cart-transform function reads at checkout — i.e. straight onto a
 * real shopper's bill.
 *
 * A variant that no longer resolves keeps whatever price and name its existing
 * row holds, so a merchant can still open and fix the bundle. On a create there
 * is no such row, so the save is rejected — `bundle_item.price` is NOT NULL and
 * there is nothing honest to put in it.
 */
async function verifyItems(
  c: Context<AppEnv>,
  currency: string,
  items: BundleItemInput[],
  existing: BundleItemRow[],
  // True when `items` came off a request body, where `priceAdjustment` is in
  // MAJOR units. False for items rebuilt from stored rows, whose adjustments
  // are ALREADY minor units — running those through `toMinorUnits` again would
  // scale them by the currency exponent twice.
  convertAdjustment: boolean,
): Promise<BundleItemDraft[]> {
  const adjustment = (value: number | undefined): number | null => {
    if (value === undefined) return null;
    return convertAdjustment ? toMinorUnits(value, currency) : value;
  };

  // Bounded before Shopify is asked: `nodes(ids:)` tops out at 250 ids, so an
  // unbounded list reaches the Admin API and comes back as an opaque 502.
  if (items.length > MAX_VARIANT_IDS) {
    throw new HttpError(
      400,
      `A bundle can hold at most ${MAX_VARIANT_IDS} items; this request has ${items.length}.`,
    );
  }

  const malformed = items.filter((i) => !VARIANT_GID.test(i.variantId));
  if (malformed.length > 0) {
    throw new HttpError(
      400,
      `Not ProductVariant ids: ${malformed.map((i) => i.variantId).join(', ')}`,
    );
  }

  // `qty` is load-bearing money now, not a cosmetic count: the bundle total is
  // computed as `sum(price * qty)`, so a fractional qty makes `toMoney` slice a
  // non-integer by string position and render as `$NaN`, while
  // `compositionFromItems` rounds the SAME value to an integer for the
  // metafield — D1 and `composition_v2` then disagree about what the shopper
  // gets. A whole positive number is the only honest input.
  const badQty = items.filter((i) => !Number.isInteger(i.qty) || i.qty <= 0);
  if (badQty.length > 0) {
    throw new HttpError(
      400,
      `Quantity must be a whole number greater than zero: ${badQty
        .map((i) => `${i.variantId} (qty ${i.qty})`)
        .join(', ')}`,
    );
  }

  // `bundle_item` has a `(bundle_id, variant_id)` unique index, so a duplicated
  // variant fails the whole `replaceForBundle` batch — a 500 for what is plainly
  // a bad request.
  const seenVariants = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seenVariants.has(item.variantId)) duplicates.add(item.variantId);
    seenVariants.add(item.variantId);
  }
  if (duplicates.size > 0) {
    throw new HttpError(
      400,
      `Duplicate items for the same variant: ${[...duplicates].join(', ')}. Use one row per variant and set its quantity.`,
    );
  }

  const shopDomain = requireShopDomain(c);
  let resolved;
  try {
    resolved = await resolveVariants(
      shopDomain,
      c.env,
      items.map((i) => i.variantId),
    );
  } catch (err) {
    // `resolveVariants` already prefixes both of its failure modes with
    // "Failed to resolve variants: " — surface its message verbatim rather
    // than wrapping it a second time.
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }

  const priorByVariant = new Map(existing.map((row) => [row.variantId, row]));

  return items.map((item) => {
    const live = resolved.get(item.variantId);
    const prior = priorByVariant.get(item.variantId);

    if (live?.exists && live.price !== undefined) {
      return {
        variantId: item.variantId,
        name: variantDisplayName(live) ?? item.variantId,
        qty: item.qty,
        price: toMinorUnits(live.price, currency),
        priceAdjustment: adjustment(item.priceAdjustment),
        titleOverride: item.titleOverride ?? null,
      };
    }

    if (!prior) {
      throw new HttpError(
        400,
        `${item.variantId} no longer exists in Shopify, so its price can't be determined. Remove it from the bundle.`,
      );
    }

    // Deleted, but we already hold what it cost and what it was called.
    return {
      variantId: item.variantId,
      name: prior.name,
      qty: item.qty,
      price: prior.price,
      priceAdjustment: adjustment(item.priceAdjustment),
      titleOverride: item.titleOverride ?? null,
    };
  });
}

/**
 * Stored rows -> the shape the metafield helpers take. The Rust side's
 * `BundleComponent.price` is a MAJOR-unit float, so the minor units in D1 are
 * converted here, once, at the boundary.
 */
function toMetafieldItems(rows: BundleItemRow[], currency: string): BundleItemLike[] {
  return rows.map((r) => ({
    variantId: r.variantId,
    qty: r.qty,
    price: toMajorNumber(r.price, currency),
  }));
}

/** True when a request body tries to dictate `sumOfItems`, which is computed. */
function hasSumOfItems(body: unknown): boolean {
  return (body as { sumOfItems?: unknown }).sumOfItems !== undefined;
}

// GET /api/bundles — the caller's shop's bundles plus a summary strip.
// `inCampaigns` is 0 until bundle campaigns land (E7). `avgSaving` is the mean
// per-bundle (sumOfItems - price) over bundles with both set.
//
// Item rows and their sums are fetched in TWO queries total, not two per
// bundle — see `sumsByBundle` / `findAll` below.
bundleRoutes.get('/api/bundles', async (c) => {
  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const currency = await shopCurrency(c);

  const rows = await bundleRepo.findAll();
  const sums = await bundleItems.sumsByBundle();
  const allItems = await bundleItems.findAll();

  const itemsByBundle = new Map<string, BundleItemRow[]>();
  for (const item of allItems) {
    const list = itemsByBundle.get(item.bundleId) ?? [];
    list.push(item);
    itemsByBundle.set(item.bundleId, list);
  }
  // No sort here: `bundleItems.findAll()` is already ordered by name, and this
  // grouping is stable, so each bundle's list comes out in the same order
  // `listForBundle` (and therefore `GET /api/bundles/:id`) produces. Ordering
  // is the repository's job — see `BundleItemRepository.findAll`.

  const bundles = rows.map((row) =>
    toDto(row, itemsByBundle.get(row.id) ?? [], sums.get(row.id) ?? null, currency),
  );

  const savings = rows
    .filter((r) => r.price !== null && sums.get(r.id) !== undefined)
    .map((r) => (sums.get(r.id) as number) - (r.price as number));
  // MoneyV2 | null, never 0 — "no bundles with a saving" is not "saves nothing".
  const avgSaving =
    savings.length === 0
      ? null
      : toMoney(Math.round(savings.reduce((sum, s) => sum + s, 0) / savings.length), currency);

  return c.json({
    bundles,
    summary: { count: bundles.length, inCampaigns: 0, avgSaving },
  });
});

// GET /api/bundles/activation — reports whether the cart-transform function
// is registered for the caller's shop, idempotently registering it if not
// (mirrors the best-effort registration attempted at install time — this
// endpoint lets the UI retry/reflect that state on demand). Registered
// before `/api/bundles/:id` so `activation` isn't swallowed as an `:id`.
bundleRoutes.get('/api/bundles/activation', async (c) => {
  const shopId = c.get('shopId');

  try {
    const shopDomain = requireShopDomain(c);
    const result = await ensureCartTransform(c.env, shopDomain, c.get('repos').shops, shopId);

    // Idempotently removes the app's two `$app:cart-transform` metafield
    // definitions if present — covers a store that had them created by a
    // prior version of this app (before we learned a `MERCHANT_READ`
    // definition on this namespace/key causes Shopify to reject this app's
    // own `metafieldsSet` writes). A definition that's already absent is a
    // no-op. Best-effort: a failure here must never block activation (the
    // underlying metafield reads/writes this app relies on work regardless
    // of whether a definition exists).
    try {
      await removeCartTransformMetafieldDefinitions(c.env, shopDomain);
    } catch (err) {
      console.error(`[bundles] removeCartTransformMetafieldDefinitions threw for ${shopDomain}:`, err);
    }

    // Reports ground truth on whether the shop's merge_bundles value has
    // actually been written. Best-effort: on failure `metafields` is simply
    // omitted from the response (not fabricated as all-false) — the UI
    // treats a missing `metafields` the same as "unknown, don't warn".
    let metafields: Awaited<ReturnType<typeof getMetafieldSetupStatus>> | undefined;
    try {
      metafields = await getMetafieldSetupStatus(c.env, shopDomain);
    } catch (err) {
      console.error(`[bundles] getMetafieldSetupStatus threw for ${shopDomain}:`, err);
    }

    if ('conflict' in result) {
      return c.json({ active: false, conflict: true, metafields });
    }
    return c.json({ active: true, metafields });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ active: false, error: message }, 500);
  }
});

// GET /api/bundles/:id — single row scoped to the caller's shop (404 when missing).
bundleRoutes.get('/api/bundles/:id', async (c) => {
  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const id = c.req.param('id');

  const row = await bundleRepo.findById(id);
  if (!row) return c.json({ error: 'Bundle not found' }, 404);

  const currency = await shopCurrency(c);
  const items = await bundleItems.listForBundle(id);
  const sum = await bundleItems.sumFor(id);

  return c.json({ bundle: toDto(row, items, sum, currency) });
});

interface ProductVariantResponse {
  productVariant: {
    id: string;
    product: { id: string } | null;
  } | null;
}

const PRODUCT_VARIANT_QUERY = `
  query BundleParentProduct($id: ID!) {
    productVariant(id: $id) {
      id
      product { id }
    }
  }
`;

// GET /api/bundles/:id/admin-url — resolves the bundle's parent variant's
// owning product and returns a deep link into the Shopify admin. Resolved
// server-side (on click) rather than at list-load time — the client has no
// Admin API access (the offline token lives server-side), and eagerly
// resolving every row's product on list load would be an N+1 Admin API call.
bundleRoutes.get('/api/bundles/:id/admin-url', async (c) => {
  const bundleRepo = c.get('repos').bundles;
  const row = await bundleRepo.findById(c.req.param('id'));

  if (!row) return c.json({ error: 'Bundle not found' }, 404);
  if (!row.parentVariantId) {
    return c.json({ error: 'This bundle has no parent variant to view.' }, 400);
  }

  const shopDomain = requireShopDomain(c);

  let result;
  try {
    result = await adminGraphql<ProductVariantResponse>(shopDomain, c.env, PRODUCT_VARIANT_QUERY, {
      id: row.parentVariantId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to resolve the parent product: ${message}` }, 502);
  }

  if (result.errors && result.errors.length > 0) {
    return c.json(
      { error: `Failed to resolve the parent product: ${JSON.stringify(result.errors)}` },
      502,
    );
  }

  const productGid = result.data?.productVariant?.product?.id;
  if (!productGid) {
    return c.json(
      { error: `Failed to resolve the parent product for variant ${row.parentVariantId}` },
      502,
    );
  }

  const match = productGid.match(/(\d+)$/);
  if (!match) {
    return c.json({ error: `Unexpected product id shape: ${productGid}` }, 502);
  }
  const productNumericId = match[1];

  return c.json({ url: `https://${shopDomain}/admin/products/${productNumericId}` });
});

// POST /api/bundles — create a bundle in Draft with no metafield written yet.
// For an `expand` bundle with a parent variant, immediately writes the
// `bundle.composition_v2` metafield so the row and the Shopify-side data
// stay in lockstep. A metafield-write failure surfaces as an error response
// (the row is still created, but its `metafieldState` stays `NotYet`).
bundleRoutes.post('/api/bundles', async (c) => {
  const body = await c.req.json<BundleInput>();

  // Fail loudly on missing required fields — never mask with `?? ''`, but
  // return a proper JSON 4xx (not a thrown Error, which Hono's default
  // handler turns into a plain-text 500).
  if (!body.name) return c.json({ error: 'Bundle name is required' }, 400);
  if (!body.operation) return c.json({ error: 'Bundle operation is required' }, 400);
  if (!body.items) return c.json({ error: 'Bundle items are required' }, 400);
  // Shape, not just presence: `items: {}` is truthy and would reach `.filter`
  // and `.map` below as a 500 instead of the 400 it plainly is.
  if (!Array.isArray(body.items)) {
    return c.json({ error: 'Bundle items must be an array.' }, 400);
  }

  // An expand bundle with zero items would write `bundle.composition_v2 =
  // "[]"` below — the Rust cart-transform function treats an empty
  // composition as a hard error and aborts the whole cart-transform
  // invocation. Reject before any write happens.
  if (body.operation === 'expand' && body.items.length === 0) {
    return c.json({ error: 'An expand bundle needs at least one component item.' }, 400);
  }

  // A merge bundle with no price would fall back to `?? 0` below, silently
  // becoming a 100%-off (free) line on the Rust side — reject before any
  // write. Likewise a merge bundle with no parent variant has nothing to
  // merge into, and would otherwise create a row that never writes its
  // `checkout.merge_bundles` entry with no indication anything is wrong.
  if (body.operation === 'merge') {
    if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price <= 0) {
      return c.json({ error: 'A merge bundle needs a price.' }, 400);
    }
    if (!body.parentVariantId) {
      return c.json({ error: 'A merge bundle needs a parent variant.' }, 400);
    }
  }

  if (hasSumOfItems(body)) {
    return c.json(
      { error: 'sumOfItems is computed from the bundle’s items and cannot be set.' },
      400,
    );
  }

  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const currency = await shopCurrency(c);

  // Before the row exists: a price we cannot verify must not become a row at
  // all. There is no prior `bundle_item` to fall back on for a create, so an
  // unresolvable variant is a 400, not a zero.
  let drafts: BundleItemDraft[];
  try {
    drafts = await verifyItems(c, currency, body.items, [], true);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  // No id, no shopId, no timestamps: the repository mints the first and the
  // last, and injects the tenant it was constructed with.
  const row: Row = await bundleRepo.create({
    name: body.name,
    operation: body.operation,
    parentVariantId: body.parentVariantId ?? null,
    price: body.price === undefined ? null : toMinorUnits(body.price, currency),
    metafieldState: 'NotYet',
    metafieldGid: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: body.status ?? 'Draft',
    blockOnFailure: 0,
  });

  // One atomic batch, so the bundle is never left half-componented.
  const itemRows = await bundleItems.replaceForBundle(row.id, drafts);
  const sum = await bundleItems.sumFor(row.id);
  const forMetafield = toMetafieldItems(itemRows, currency);

  if (row.operation === 'expand' && row.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      const { metafieldGid } = await writeComposition(c.env, shopDomain, row.parentVariantId, forMetafield);
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(row.id, 'Written', metafieldGid);
    } catch (err) {
      // The row is already created (metafieldState='NotYet') — surface the
      // failure loudly instead of letting the client believe it succeeded.
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Bundle created but composition_v2 write failed: ${message}`, bundle: toDto(row, itemRows, sum, currency) },
        502,
      );
    }
  } else if (row.operation === 'merge' && row.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      // `body.price` is guaranteed a finite, positive number here — the
      // merge guard above (`body.operation === 'merge'`) already rejected
      // any request that reaches this branch (`row.operation === 'merge'`,
      // copied straight from `body.operation`) without one.
      const entry = mergeConfigEntry({ parentVariantId: row.parentVariantId, price: body.price!, items: forMetafield, title: body.name });
      const { metafieldGid } = await upsertMergeConfig(c.env, shopDomain, entry);
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(row.id, 'Written', metafieldGid);
    } catch (err) {
      // The row is already created (metafieldState='NotYet') — surface the
      // failure loudly instead of letting the client believe it succeeded.
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Bundle created but merge_bundles write failed: ${message}`, bundle: toDto(row, itemRows, sum, currency) },
        502,
      );
    }
  }

  return c.json({ bundle: toDto(row, itemRows, sum, currency) }, 201);
});

// PUT /api/bundles/:id — partial update, scoped to the caller's shop (404 when missing).
bundleRoutes.put('/api/bundles/:id', async (c) => {
  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const id = c.req.param('id');

  const existing = await bundleRepo.findById(id);
  if (!existing) return c.json({ error: 'Bundle not found' }, 404);

  const body = await c.req.json<Partial<BundleInput>>();

  if (hasSumOfItems(body)) {
    return c.json(
      { error: 'sumOfItems is computed from the bundle’s items and cannot be set.' },
      400,
    );
  }

  // ONE predicate for "this PUT replaces the components", used by the fallback
  // below AND by the re-resolution gate further down. They used to be spelled
  // differently (`body.items ?? …` vs `body.items !== undefined`), and
  // `items: null` fell into the gap: the fallback rebuilt the stored rows,
  // whose `priceAdjustment` is ALREADY minor units, and the gate then handed
  // them to `verifyItems(convertAdjustment: true)`, scaling a stored 500
  // (A$5.00) to 50000 (A$500.00) on every such PUT.
  //
  // `null` is a 400, not "no change": omitting the key already says "leave the
  // components alone", so an explicit `null` adds no meaning and is a client
  // bug worth surfacing rather than silently reinterpreting.
  const bodyItems = body.items;
  const replacesItems = bodyItems !== undefined;
  if (replacesItems && !Array.isArray(bodyItems)) {
    return c.json({ error: 'Bundle items must be an array. Omit `items` to leave them unchanged.' }, 400);
  }

  const currency = await shopCurrency(c);
  const existingItems = await bundleItems.listForBundle(id);

  // Effective operation/items after this PUT is applied — reject before any
  // write if the result would be an expand bundle with zero items (see the
  // matching guard in POST for why: an empty composition_v2 aborts the
  // Rust cart-transform function entirely).
  //
  // A PUT that doesn't touch `items` keeps the bundle's current components,
  // rebuilt from the stored rows. Used ONLY by the guards below — such a PUT
  // never re-resolves or rewrites those rows (see the `drafts` block), so no
  // `price` needs carrying across.
  const effectiveOperation = body.operation ?? existing.operation;
  const effectiveItems: BundleItemInput[] = replacesItems
    ? bodyItems
    : existingItems.map((item) => ({
      variantId: item.variantId,
      qty: item.qty,
      ...(item.priceAdjustment !== null ? { priceAdjustment: item.priceAdjustment } : {}),
      ...(item.titleOverride ? { titleOverride: item.titleOverride } : {}),
    }));
  if (effectiveOperation === 'expand' && effectiveItems.length === 0) {
    return c.json({ error: 'An expand bundle needs at least one component item.' }, 400);
  }

  // Mirrors the POST guard: a merge bundle with no price would fall back to
  // `?? 0` in Phase 2 below, silently becoming a 100%-off (free) line on the
  // Rust side, and a merge bundle with no parent variant has nothing to
  // merge into. The effective value is whichever this PUT sets, or (if this
  // PUT doesn't touch that field) whatever the existing row already has.
  if (effectiveOperation === 'merge') {
    const effectivePrice =
      body.price !== undefined
        ? body.price
        : existing.price === null
          ? null
          : toMajorNumber(existing.price, currency);
    if (typeof effectivePrice !== 'number' || !Number.isFinite(effectivePrice) || effectivePrice <= 0) {
      return c.json({ error: 'A merge bundle needs a price.' }, 400);
    }
    const effectiveParentVariantId =
      body.parentVariantId !== undefined ? body.parentVariantId : existing.parentVariantId;
    if (!effectiveParentVariantId) {
      return c.json({ error: 'A merge bundle needs a parent variant.' }, 400);
    }
  }

  // No `updatedAt` here — `update()` stamps it, so a patch cannot forget to.
  const patch: Partial<Row> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.operation !== undefined) patch.operation = body.operation;
  if (body.parentVariantId !== undefined) patch.parentVariantId = body.parentVariantId;
  if (body.price !== undefined) patch.price = toMinorUnits(body.price, currency);
  if (body.status !== undefined) patch.status = body.status;

  // Re-resolution exists to verify prices the CLIENT sent. A PUT that carries
  // no `items` has nothing to verify — the stored rows were verified when they
  // were last written — so it leaves them alone entirely: no Admin round-trip,
  // no `replaceForBundle`, no re-minted ids.
  //
  // This is not just an optimisation. The composition rewrite below is
  // deliberately skipped on a rename (`compositionInputsChanged`), so
  // re-pricing the rows here would move `bundle_item.price` — and with it
  // `sumOfItems` and everything the merchant sees — while `composition_v2`
  // kept charging the old price at checkout. Displaying one price and billing
  // another is worse than both being equally stale.
  //
  // Resolved BEFORE the row is touched, so an unverifiable price aborts the
  // whole PUT rather than leaving a half-applied edit behind.
  let drafts: BundleItemDraft[] | null = null;
  if (replacesItems) {
    try {
      // Always major units here: this branch only runs for client-sent items.
      drafts = await verifyItems(c, currency, effectiveItems, existingItems, true);
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  }

  // The stored row, straight back from the write — no re-deriving it locally.
  const merged: Row = await bundleRepo.update(id, patch);
  const itemRows = drafts === null ? existingItems : await bundleItems.replaceForBundle(id, drafts);
  const sum = await bundleItems.sumFor(id);
  const forMetafield = toMetafieldItems(itemRows, currency);

  // A bundle uses AT MOST ONE metafield transport at a time — `expand` ->
  // the variant `bundle.composition_v2` metafield, `merge` -> the shop
  // `checkout.merge_bundles` metafield, `update` -> none. `metafieldState`/
  // `metafieldGid` track whichever transport is currently live. Reconcile in
  // two ordered phases so a bundle is never left pointing at two live
  // transports (or a stale one the Rust cart-transform function keeps
  // reading): first clear the OLD transport if this PUT moves the bundle
  // away from the operation that owns it, then write the NEW transport if
  // this PUT moves the bundle into (or keeps it in, with changed inputs) an
  // operation that owns one.
  const prevOp = existing.operation;
  const newOp = effectiveOperation;

  // Only when this PUT actually changed an input that feeds the written
  // config, OR the operation itself changed into that transport — a plain
  // rename/status-change PUT on an already-written bundle must not trigger
  // an extra Admin API round-trip (or a spurious 502 if it fails), but a
  // transition INTO `expand`/`merge` must always (re)write, even if
  // items/parentVariantId happen to be unchanged from before.
  const compositionInputsChanged = replacesItems || body.parentVariantId !== undefined;
  const mergeInputsChanged =
    replacesItems ||
    body.parentVariantId !== undefined ||
    body.price !== undefined ||
    body.name !== undefined;

  // Phase 1 — clear the OLD transport when this PUT moves the bundle away
  // from the operation that owns it. Best-effort: a stale metafield on the
  // old owner is a lesser problem than blocking the PUT on Shopify being
  // reachable, but the row's tracked state is still flipped to `Cleared` so
  // it doesn't keep claiming a metafield that (from this row's perspective)
  // no longer applies.
  if (prevOp === 'expand' && newOp !== 'expand' && existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      await clearComposition(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to clear composition_v2 for bundle ${id} on operation change:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await bundleRepo.setMetafieldState(id, 'Cleared', null);
  } else if (prevOp === 'merge' && newOp !== 'merge' && existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to remove merge_bundles entry for bundle ${id} on operation change:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await bundleRepo.setMetafieldState(id, 'Cleared', null);
  } else if (
    prevOp === 'merge' &&
    newOp === 'merge' &&
    existing.metafieldState === 'Written' &&
    existing.parentVariantId &&
    merged.parentVariantId &&
    existing.parentVariantId !== merged.parentVariantId
  ) {
    // A merge bundle whose parent variant changed still owns a
    // `checkout.merge_bundles` entry keyed by the OLD parent variant.
    // `upsertMergeConfig` (Phase 2, below) only replaces an entry matching
    // the NEW parent's id, so without this the stale old-parent entry would
    // survive alongside the new one — and since Pass 3 in the Rust
    // cart-transform function matches by variant id, the stale entry can
    // still win and merge into the wrong variant. Best-effort, like the
    // other Phase 1 clears above: `metafieldState`/`metafieldGid` are left
    // alone here (Phase 2 rewrites them for the new parent regardless).
    try {
      const shopDomain = requireShopDomain(c);
      await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(
        `[bundles] failed to remove stale merge_bundles entry for bundle ${id} on parent-variant change:`,
        err,
      );
    }
  }

  // Phase 2 — write the NEW transport. A failure here surfaces as a 502
  // (the row's phase-1 clear, if any, already committed — never mask a
  // failed write by leaving the client thinking it succeeded).
  if (newOp === 'expand' && merged.parentVariantId && (newOp !== prevOp || compositionInputsChanged)) {
    try {
      const shopDomain = requireShopDomain(c);
      const { metafieldGid } = await writeComposition(c.env, shopDomain, merged.parentVariantId, forMetafield);
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(id, 'Written', metafieldGid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: `Bundle updated but composition_v2 write failed: ${message}`,
          bundle: toDto(merged, itemRows, sum, currency),
        },
        502,
      );
    }
  } else if (newOp === 'merge' && merged.parentVariantId && (newOp !== prevOp || mergeInputsChanged)) {
    try {
      const shopDomain = requireShopDomain(c);
      // `merged.price` is guaranteed a finite, positive dollar value here —
      // the merge guard above already rejected any request reaching this
      // branch without one.
      const entry = mergeConfigEntry({
        parentVariantId: merged.parentVariantId,
        price: toMajorNumber(merged.price!, currency),
        items: forMetafield,
        title: merged.name,
      });
      const { metafieldGid } = await upsertMergeConfig(c.env, shopDomain, entry);
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(id, 'Written', metafieldGid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: `Bundle updated but merge_bundles write failed: ${message}`,
          bundle: toDto(merged, itemRows, sum, currency),
        },
        502,
      );
    }
  }

  return c.json({ bundle: toDto(merged, itemRows, sum, currency) });
});

// DELETE /api/bundles/:id — scoped to the caller's shop (404 when missing).
bundleRoutes.delete('/api/bundles/:id', async (c) => {
  const bundleRepo = c.get('repos').bundles;
  const id = c.req.param('id');

  const existing = await bundleRepo.findById(id);
  if (!existing) return c.json({ error: 'Bundle not found' }, 404);

  // Best-effort: clearing the metafield is not fatal to the delete — the
  // row is going away regardless, and a stale composition_v2/merge_bundles
  // entry is a lesser problem than blocking delete on Shopify being
  // reachable. Failures are logged, not surfaced to the client.
  if (existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      if (existing.operation === 'expand') {
        await clearComposition(c.env, shopDomain, existing.parentVariantId);
      } else if (existing.operation === 'merge') {
        await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
      }
    } catch (err) {
      console.error(`[bundles] failed to clear metafield for bundle ${id}:`, err);
    }
  }

  await bundleRepo.delete(id);

  return c.json({ ok: true });
});
