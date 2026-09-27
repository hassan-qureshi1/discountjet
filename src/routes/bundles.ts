import { isPlusPlan, planGateReason } from '../lib/shopPlan';
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
import {
  resolveVariants,
  variantDisplayName,
  VARIANT_GID,
  MAX_VARIANT_IDS,
  type ResolvedVariant,
} from '../lib/variantResolver';
import { ensureCartTransform } from '../lib/cartTransformRegistration';
import { assertWindowOrder, deriveStatus, normalizeUtc, shouldBeLive } from '../lib/scheduleWindow';
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
  /** UTC ISO-8601, or null for "no bound". Normalized server-side. */
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
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
  scheduleStart: string | null;
  scheduleEnd: string | null;
  scheduleError: string | null;
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

/**
 * Refuses an `update` bundle on a store whose plan does not allow it.
 *
 * Enforced here as well as in the UI, because the UI gate is only a disabled
 * menu row: anything posting straight to the API would otherwise store a
 * bundle the store cannot run. The plan is read from the shop row exactly as
 * Shopify reported it, and only the comparison is ours.
 */
async function assertOperationAllowed(
  c: Context<AppEnv>,
  operation: Row['operation'] | undefined,
): Promise<void> {
  if (operation !== 'update') return;

  const shop = await c.get('repos').shops.findById(c.get('shopId'));
  const plan = shop?.planName ?? shop?.plan ?? null;
  if (isPlusPlan(plan)) return;

  throw new HttpError(400, `Update bundles are not available on this plan. ${planGateReason(plan)}`);
}

/**
 * Resolve the effective window and the status it implies.
 *
 * `status` is not freely settable by the client any more: the schedule owns
 * Active/Scheduled/Ended, and the client may only choose `Draft` (the manual
 * off-switch) or leave it to the window. A client sending `Active` on a future
 * window is ignored rather than rejected, so an older build cannot pin a bundle
 * live past its end date.
 *
 * Throws `HttpError(400)` — never returns a null bound for an unparseable
 * input, because a null bound means "no bound", i.e. permanently live.
 */
function resolveSchedule(
  requested: { scheduleStart?: string | null; scheduleEnd?: string | null; status?: string },
  current: { scheduleStart: string | null; scheduleEnd: string | null },
  now: string,
): { scheduleStart: string | null; scheduleEnd: string | null; status: Row['status'] } {
  const pick = (field: 'scheduleStart' | 'scheduleEnd'): string | null => {
    const value = requested[field];
    if (value === undefined) return current[field];
    if (value === null) return null;
    try {
      return normalizeUtc(value);
    } catch {
      throw new HttpError(400, `${field} is not a valid date and time.`);
    }
  };

  const scheduleStart = pick('scheduleStart');
  const scheduleEnd = pick('scheduleEnd');

  try {
    assertWindowOrder(scheduleStart, scheduleEnd);
  } catch {
    throw new HttpError(400, 'The schedule start must be before the schedule end.');
  }

  const status: Row['status'] =
    requested.status === 'Draft' ? 'Draft' : deriveStatus(scheduleStart, scheduleEnd, now);

  return { scheduleStart, scheduleEnd, status };
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
    scheduleStart: row.scheduleStart,
    scheduleEnd: row.scheduleEnd,
    scheduleError: row.scheduleError,
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
async function resolveOrThrow(
  c: Context<AppEnv>,
  ids: string[],
): Promise<Map<string, ResolvedVariant>> {
  const shopDomain = requireShopDomain(c);
  try {
    return await resolveVariants(shopDomain, c.env, ids);
  } catch (err) {
    // `resolveVariants` already prefixes both of its failure modes with
    // "Failed to resolve variants: " — surface its message verbatim rather
    // than wrapping it a second time.
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The bundle's target ("parent") variant must still exist in Shopify.
 *
 * It is the one variant a bundle depends on that is NOT a `bundle_item` row,
 * so nothing else on the save path verifies it. Left unchecked, a merchant who
 * deletes the target product keeps saving cleanly while the cart transform
 * emits a `linesMerge`/`composition_v2` pointing at a dead gid.
 *
 * Unlike a component, a dead target cannot be removed — the bundle needs one —
 * so the fix is to choose a different variant, and the message says so.
 */
function assertParentResolves(
  parentVariantId: string,
  resolved: Map<string, ResolvedVariant>,
): void {
  if (!resolved.get(parentVariantId)?.exists) {
    throw new HttpError(
      400,
      `The target variant ${parentVariantId} no longer exists in Shopify. Choose a new target variant, or set this bundle to Draft.`,
    );
  }
}

/**
 * A merge bundle's price must be BELOW what its components cost.
 *
 * `linesMerge` can only ever reduce a price: the Rust cart transform turns the
 * target into a percentage off the live cart subtotal, and clamps the result to
 * `0..=100`. A target at or above the subtotal therefore asks for a negative
 * discount, which clamps to zero — the merged line silently renders at full
 * price with no error anywhere. Rejecting it here is the only place a merchant
 * can be told, because at checkout it looks like nothing happened.
 *
 * The comparison uses stored component prices as a proxy for the cart subtotal.
 * A shopper's real subtotal can differ (quantities, a sale price), so this
 * catches the configuration that can NEVER discount, not every case that might
 * not.
 */
function assertPriceBelowComponents(
  priceMinor: number,
  items: Array<{ price: number; qty: number }>,
  currency: string,
): void {
  if (items.length === 0) return;
  const componentsMinor = items.reduce((total, i) => total + i.price * i.qty, 0);
  if (priceMinor < componentsMinor) return;

  const asked = toMoney(priceMinor, currency)!.amount;
  const worth = toMoney(componentsMinor, currency)!.amount;
  throw new HttpError(
    400,
    `A merge bundle's price has to be less than its components, which come to ${worth} ${currency}. `
    + `At ${asked} ${currency} there is nothing to discount, so the bundle would show at full price.`,
  );
}

/**
 * An expand bundle's price must be BELOW what the bundle product itself costs.
 *
 * The base differs from merge, and that is Shopify's rule rather than ours:
 * `linesMerge` adjusts against the components' price sum, `lineExpand` against
 * the BUNDLE PRODUCT price. Both can only ever decrease — `PriceAdjustment`
 * exposes `percentageDecrease` and nothing else — so a target at or above the
 * parent's own price has no representation and the cart transform ignores it,
 * leaving the line at full price with nothing to explain why.
 */
function assertExpandPriceBelowParent(
  priceMinor: number,
  parent: ResolvedVariant | undefined,
  currency: string,
): void {
  // No live parent price to compare against: the target variant check has
  // already run, so this is a resolve that returned no price rather than a
  // deleted variant. Let the save through rather than block on a comparison
  // we cannot make.
  if (parent?.price === undefined) return;

  const parentMinor = toMinorUnits(parent.price, currency);
  if (priceMinor < parentMinor) return;

  const asked = toMoney(priceMinor, currency)!.amount;
  const product = toMoney(parentMinor, currency)!.amount;
  throw new HttpError(
    400,
    `An expand bundle's price has to be less than the bundle product's own price of `
    + `${product} ${currency}. At ${asked} ${currency} there is nothing to discount, so the `
    + `line would show at full price.`,
  );
}

/** Rejects a target variant id that isn't a ProductVariant gid at all. */
function assertParentShape(parentVariantId: string): void {
  if (!VARIANT_GID.test(parentVariantId)) {
    throw new HttpError(400, `Not a ProductVariant id: ${parentVariantId}`);
  }
}

/**
 * A PUT may skip the target-variant check when the bundle ends up inactive.
 *
 * Without this a merchant whose target product was deleted could neither fix
 * the bundle NOR switch it off — the block would trap them with a live, broken
 * bundle. Draft and Ended are both inactive, so letting those through costs
 * nothing at checkout. A CREATE always runs the check regardless: there is no
 * `existing` row yet for it to read a status from, so this early-out never
 * applies to it.
 */
function isInactiveStatus(status: Row['status'] | undefined): boolean {
  return status === 'Draft' || status === 'Ended';
}

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
  // Resolved in the SAME `nodes(ids:)` call as the items. The bundle's target
  // variant goes here so verifying it costs no extra Admin round-trip.
  extraIds: string[] = [],
): Promise<{ drafts: BundleItemDraft[]; resolved: Map<string, ResolvedVariant> }> {
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

  const resolved = await resolveOrThrow(c, [...items.map((i) => i.variantId), ...extraIds]);

  const priorByVariant = new Map(existing.map((row) => [row.variantId, row]));

  const drafts = items.map((item) => {
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

  return { drafts, resolved };
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

  // An `update` bundle writes no metafield, so `parentVariantId` is the only
  // record of which cart line the override applies to. Without it the row is
  // meaningless and the editor has nothing to render.
  if (body.operation === 'update' && !body.parentVariantId) {
    return c.json({ error: 'An update bundle needs a target variant.' }, 400);
  }

  try {
    await assertOperationAllowed(c, body.operation);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
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
  // A create ALWAYS verifies the target variant, whatever its status. The
  // inactive-status escape hatch exists so an existing broken bundle can be
  // switched off; `status` defaults to `Draft` here, so honouring it would
  // disable the check for almost every new bundle.
  let drafts: BundleItemDraft[];
  try {
    const parentVariantId = body.parentVariantId;
    if (parentVariantId !== undefined) assertParentShape(parentVariantId);

    const verified = await verifyItems(
      c,
      currency,
      body.items,
      [],
      true,
      parentVariantId === undefined ? [] : [parentVariantId],
    );
    drafts = verified.drafts;

    if (parentVariantId !== undefined) assertParentResolves(parentVariantId, verified.resolved);

    if (body.price !== undefined) {
      const priceMinor = toMinorUnits(body.price, currency);
      if (body.operation === 'merge') {
        assertPriceBelowComponents(priceMinor, drafts, currency);
      } else if (body.operation === 'expand' && parentVariantId !== undefined) {
        assertExpandPriceBelowParent(priceMinor, verified.resolved.get(parentVariantId), currency);
      }
    }
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  let schedule: ReturnType<typeof resolveSchedule>;
  try {
    schedule = resolveSchedule(body, { scheduleStart: null, scheduleEnd: null }, new Date().toISOString());
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
    scheduleStart: schedule.scheduleStart,
    scheduleEnd: schedule.scheduleEnd,
    scheduleError: null,
    status: schedule.status,
    blockOnFailure: 0,
  });

  // One atomic batch, so the bundle is never left half-componented.
  const itemRows = await bundleItems.replaceForBundle(row.id, drafts);
  const sum = await bundleItems.sumFor(row.id);
  const forMetafield = toMetafieldItems(itemRows, currency);

  // The schedule gate. Without it, a bundle scheduled for next Friday would
  // have its composition metafield written NOW — live at checkout a week early,
  // while the UI shows `Scheduled`.
  if (shouldBeLive(row.status) && row.operation === 'expand' && row.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      const { metafieldGid } = await writeComposition(
        c.env,
        shopDomain,
        row.parentVariantId,
        forMetafield,
        row.price === null ? null : toMajorNumber(row.price, currency),
      );
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(row.id, 'Written', metafieldGid);
    } catch (err) {
      // The row is already created (metafieldState='NotYet') — surface the
      // failure loudly instead of letting the client believe it succeeded.
      // Persist the failure onto the row too: without a bound end date the
      // scanner never revisits this bundle, so `scheduleError` is the only
      // thing that will ever surface the lie to the merchant.
      const message = err instanceof Error ? err.message : String(err);
      const failed = await bundleRepo.update(row.id, { scheduleError: message });
      return c.json(
        { error: `Bundle created but composition_v2 write failed: ${message}`, bundle: toDto(failed, itemRows, sum, currency) },
        502,
      );
    }
  } else if (shouldBeLive(row.status) && row.operation === 'merge' && row.parentVariantId) {
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
      // Persist the failure onto the row too: without a bound end date the
      // scanner never revisits this bundle, so `scheduleError` is the only
      // thing that will ever surface the lie to the merchant.
      const message = err instanceof Error ? err.message : String(err);
      const failed = await bundleRepo.update(row.id, { scheduleError: message });
      return c.json(
        { error: `Bundle created but merge_bundles write failed: ${message}`, bundle: toDto(failed, itemRows, sum, currency) },
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

  // Resolved BEFORE `patch` is built and before `effectiveStatus` is read, so
  // one derivation of the window feeds the stored row, the parent-check gate
  // and the metafield gates alike.
  let schedule: ReturnType<typeof resolveSchedule>;
  try {
    schedule = resolveSchedule(
      // `status` falls back to the STORED value, not to the window: `Draft` is
      // the merchant's manual off-switch and a PUT that never mentions status
      // (a rename, a price edit) must not silently switch a Draft bundle live.
      { ...body, status: body.status ?? existing.status },
      { scheduleStart: existing.scheduleStart, scheduleEnd: existing.scheduleEnd },
      new Date().toISOString(),
    );
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  // No `updatedAt` here — `update()` stamps it, so a patch cannot forget to.
  const patch: Partial<Row> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.operation !== undefined) patch.operation = body.operation;
  if (body.parentVariantId !== undefined) patch.parentVariantId = body.parentVariantId;
  if (body.price !== undefined) patch.price = toMinorUnits(body.price, currency);
  patch.status = schedule.status;
  patch.scheduleStart = schedule.scheduleStart;
  patch.scheduleEnd = schedule.scheduleEnd;
  // A merchant edit is a fresh attempt: whatever the cron failed at last time
  // is no longer the current state of this bundle.
  patch.scheduleError = null;

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
  //
  // The bundle's TARGET variant is checked separately from its items, because
  // it is not a `bundle_item` row. The EFFECTIVE target is verified — whatever
  // this PUT sets, else whatever is stored — so a merchant whose target was
  // deleted can still fix the bundle by choosing a live one. Skipped when the
  // bundle ends up Draft or Ended, so a broken bundle can always be switched
  // off rather than trapping its owner.
  const effectiveParentVariantId =
    body.parentVariantId !== undefined ? body.parentVariantId : existing.parentVariantId;
  const effectiveStatus = schedule.status;
  const checksParent = Boolean(effectiveParentVariantId) && !isInactiveStatus(effectiveStatus);

  let drafts: BundleItemDraft[] | null = null;
  let resolvedParent: ResolvedVariant | undefined;
  try {
    // The EFFECTIVE operation, so switching an existing bundle TO `update` on
    // a store that cannot run it is refused as firmly as creating one.
    await assertOperationAllowed(c, effectiveOperation);

    if (checksParent) assertParentShape(effectiveParentVariantId as string);

    if (replacesItems) {
      // Always major units here: this branch only runs for client-sent items.
      const verified = await verifyItems(
        c,
        currency,
        effectiveItems,
        existingItems,
        true,
        checksParent ? [effectiveParentVariantId as string] : [],
      );
      drafts = verified.drafts;
      if (checksParent) {
        assertParentResolves(effectiveParentVariantId as string, verified.resolved);
        resolvedParent = verified.resolved.get(effectiveParentVariantId as string);
      }
    } else if (checksParent) {
      // No items to re-resolve, but the target still has to be real. One
      // `nodes(ids:)` call with a single id — a read used to reject, which
      // writes nothing and so cannot reintroduce a price desync.
      const resolved = await resolveOrThrow(c, [effectiveParentVariantId as string]);
      assertParentResolves(effectiveParentVariantId as string, resolved);
      resolvedParent = resolved.get(effectiveParentVariantId as string);
    }

    // Outside the items branch on purpose: a PUT that changes only the PRICE
    // sends no items, and that is exactly the edit most likely to push the
    // price above what the components are worth.
    const effectivePriceMinor = body.price !== undefined
      ? toMinorUnits(body.price, currency)
      : existing.price;
    if (effectivePriceMinor !== null) {
      if (effectiveOperation === 'merge') {
        assertPriceBelowComponents(effectivePriceMinor, drafts ?? existingItems, currency);
      } else if (effectiveOperation === 'expand') {
        assertExpandPriceBelowParent(effectivePriceMinor, resolvedParent, currency);
      }
    }
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
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
  // Entering the live window is itself a reason to (re)write, even when no
  // input changed: a merchant who pulls a Scheduled bundle's start date to now
  // must not have to wait for the cron to make it live.
  const becameLive = !shouldBeLive(existing.status) && shouldBeLive(merged.status);
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
  // Set by any phase-1 branch that has already talked to Shopify about the
  // OLD transport, so the window-exit clear below cannot clear it a second
  // time (`existing.metafieldState` still reads `Written` at that point).
  let oldTransportHandled = false;

  if (prevOp === 'expand' && newOp !== 'expand' && existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      await clearComposition(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to clear composition_v2 for bundle ${id} on operation change:`, err);
    }
    oldTransportHandled = true;
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
    oldTransportHandled = true;
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
    // other Phase 1 clears above.
    try {
      const shopDomain = requireShopDomain(c);
      await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(
        `[bundles] failed to remove stale merge_bundles entry for bundle ${id} on parent-variant change:`,
        err,
      );
    }
    oldTransportHandled = true;

    // `metafieldState`/`metafieldGid` are normally left alone here, because
    // Phase 2 rewrites them for the new parent. But Phase 2 is gated on the
    // bundle being live, so a PUT that changes the parent AND lands the
    // bundle outside its window (or on `Draft`) writes nothing — and the
    // window-exit clear below is suppressed by `oldTransportHandled`. Without
    // this the row would keep claiming `Written` with the gid of an entry
    // that no longer exists, and nothing would ever revisit it: the due-scan
    // only looks at `Scheduled`/`Active` rows.
    if (!shouldBeLive(merged.status)) {
      merged.metafieldState = 'Cleared';
      merged.metafieldGid = null;
      await bundleRepo.setMetafieldState(id, 'Cleared', null);
    }
  }

  // Leaving the live window (or being switched to Draft) clears the transport,
  // the same thing the cron would do at the boundary — the cron only handles
  // boundaries that arrive while nobody is looking.
  if (
    !oldTransportHandled &&
    shouldBeLive(existing.status) &&
    !shouldBeLive(merged.status) &&
    existing.metafieldState === 'Written' &&
    existing.parentVariantId
  ) {
    try {
      const shopDomain = requireShopDomain(c);
      if (prevOp === 'expand') await clearComposition(c.env, shopDomain, existing.parentVariantId);
      else if (prevOp === 'merge') await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to clear transport for bundle ${id} leaving its window:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await bundleRepo.setMetafieldState(id, 'Cleared', null);
  }

  // Phase 2 — write the NEW transport. A failure here surfaces as a 502
  // (the row's phase-1 clear, if any, already committed — never mask a
  // failed write by leaving the client thinking it succeeded).
  if (shouldBeLive(merged.status) && newOp === 'expand' && merged.parentVariantId && (newOp !== prevOp || becameLive || compositionInputsChanged)) {
    try {
      const shopDomain = requireShopDomain(c);
      const { metafieldGid } = await writeComposition(
        c.env,
        shopDomain,
        merged.parentVariantId,
        forMetafield,
        merged.price === null ? null : toMajorNumber(merged.price, currency),
      );
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(id, 'Written', metafieldGid);
    } catch (err) {
      // Persist the failure onto the row, not just the in-memory object: a
      // bound-free (always-on) bundle is never revisited by the due-scan, so
      // `scheduleError` is the only thing that will ever surface this to the
      // merchant. The response DTO is built from the same persisted row so
      // the two never disagree.
      const message = err instanceof Error ? err.message : String(err);
      const failed = await bundleRepo.update(id, { scheduleError: message });
      return c.json(
        {
          error: `Bundle updated but composition_v2 write failed: ${message}`,
          bundle: toDto(failed, itemRows, sum, currency),
        },
        502,
      );
    }
  } else if (shouldBeLive(merged.status) && newOp === 'merge' && merged.parentVariantId && (newOp !== prevOp || becameLive || mergeInputsChanged)) {
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
      // Persist the failure onto the row, not just the in-memory object: a
      // bound-free (always-on) bundle is never revisited by the due-scan, so
      // `scheduleError` is the only thing that will ever surface this to the
      // merchant. The response DTO is built from the same persisted row so
      // the two never disagree.
      const message = err instanceof Error ? err.message : String(err);
      const failed = await bundleRepo.update(id, { scheduleError: message });
      return c.json(
        {
          error: `Bundle updated but merge_bundles write failed: ${message}`,
          bundle: toDto(failed, itemRows, sum, currency),
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
