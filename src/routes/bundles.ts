import { Hono } from 'hono';
import { createDb } from '../db/db';
import { BundleRepository, type BundleRow } from '../db/repos/bundleRepo';
import type { AppEnv } from '../types/env.d';
import {
  writeComposition,
  clearComposition,
  mergeConfigEntry,
  upsertMergeConfig,
  removeMergeConfig,
} from '../lib/bundleMetafields';
import { adminGraphql } from '../lib/graphqlAdmin';
import { requireShopDomain } from '../lib/shopDomain';
import { ensureCartTransform } from '../lib/cartTransformRegistration';
import { removeCartTransformMetafieldDefinitions, getMetafieldSetupStatus } from '../lib/metafieldDefinitions';

export const bundleRoutes = new Hono<AppEnv>();

type Row = BundleRow;

interface BundleItem {
  variantId: string;
  qty: number;
  priceAdjustment?: number;
  titleOverride?: string;
  imageOverride?: string;
  // Per-unit price in dollars, used to build the `bundle.composition_v2`
  // metafield for `expand` bundles. Populated by the editor (later task)
  // from the picked variant; no DB migration needed — `items` is stored as
  // free-form JSON text.
  price?: number;
}

interface BundleInput {
  name: string;
  operation: 'merge' | 'expand' | 'update';
  items: BundleItem[];
  parentVariantId?: string;
  price?: number; // dollars
  sumOfItems?: number; // dollars
  status?: 'Active' | 'Scheduled' | 'Ended' | 'Draft';
}

interface BundleDto {
  id: string;
  name: string;
  operation: 'merge' | 'expand' | 'update';
  items: BundleItem[];
  parentVariantId?: string;
  price: number | null;
  sumOfItems: number | null;
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

// Cents (DB) <-> dollars (UI) — round to avoid floating-point drift on the way in.
const toCents = (dollars: number) => Math.round(dollars * 100);
const toDollars = (cents: number | null) => (cents === null ? null : cents / 100);

function toDto(row: Row): BundleDto {
  return {
    id: row.id,
    name: row.name,
    operation: row.operation,
    items: JSON.parse(row.items) as BundleItem[],
    ...(row.parentVariantId ? { parentVariantId: row.parentVariantId } : {}),
    price: toDollars(row.price),
    sumOfItems: toDollars(row.sumOfItems),
    status: row.status,
    metafieldState: row.metafieldState,
    ...(row.metafieldGid ? { metafieldGid: row.metafieldGid } : {}),
    updated: relativeTime(row.updatedAt),
  };
}

// GET /api/bundles — the caller's shop's bundles plus a summary strip.
// `inCampaigns` is 0 until bundle campaigns land (E7). `avgSaving` is the mean
// per-bundle (sumOfItems - price), in dollars, over bundles with both set.
bundleRoutes.get('/api/bundles', async (c) => {
  const bundleRepo = new BundleRepository(createDb(c.env.DB));
  const rows = await bundleRepo.list(c.get('shopId'));

  const bundles = rows.map(toDto);
  const savings = rows
    .filter((r) => r.price !== null && r.sumOfItems !== null)
    .map((r) => (r.sumOfItems as number) - (r.price as number));
  const avgSaving =
    savings.length === 0
      ? 0
      : Math.round(savings.reduce((sum, s) => sum + s, 0) / savings.length / 100);

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
  const db = createDb(c.env.DB);
  const shopId = c.get('shopId');

  try {
    const shopDomain = requireShopDomain(c);
    const result = await ensureCartTransform(c.env, shopDomain, db, shopId);

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
  const bundleRepo = new BundleRepository(createDb(c.env.DB));
  const row = await bundleRepo.find(c.get('shopId'), c.req.param('id'));

  if (!row) return c.json({ error: 'Bundle not found' }, 404);
  return c.json({ bundle: toDto(row) });
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
  const bundleRepo = new BundleRepository(createDb(c.env.DB));
  const row = await bundleRepo.find(c.get('shopId'), c.req.param('id'));

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

  const shopId = c.get('shopId');
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    shopId,
    name: body.name,
    operation: body.operation,
    items: JSON.stringify(body.items),
    parentVariantId: body.parentVariantId ?? null,
    price: body.price === undefined ? null : toCents(body.price),
    sumOfItems: body.sumOfItems === undefined ? null : toCents(body.sumOfItems),
    metafieldState: 'NotYet',
    metafieldGid: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: body.status ?? 'Draft',
    blockOnFailure: 0,
    createdAt: now,
    updatedAt: now,
  };

  const bundleRepo = new BundleRepository(createDb(c.env.DB));
  await bundleRepo.insert(row);

  if (row.operation === 'expand' && row.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      const { metafieldGid } = await writeComposition(c.env, shopDomain, row.parentVariantId, body.items);
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(shopId, row.id, 'Written', metafieldGid);
    } catch (err) {
      // The row is already created (metafieldState='NotYet') — surface the
      // failure loudly instead of letting the client believe it succeeded.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Bundle created but composition_v2 write failed: ${message}`, bundle: toDto(row) }, 502);
    }
  } else if (row.operation === 'merge' && row.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      // `body.price` is guaranteed a finite, positive number here — the
      // merge guard above (`body.operation === 'merge'`) already rejected
      // any request that reaches this branch (`row.operation === 'merge'`,
      // copied straight from `body.operation`) without one.
      const entry = mergeConfigEntry({ parentVariantId: row.parentVariantId, price: body.price!, items: body.items, title: body.name });
      const { metafieldGid } = await upsertMergeConfig(c.env, shopDomain, entry);
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(shopId, row.id, 'Written', metafieldGid);
    } catch (err) {
      // The row is already created (metafieldState='NotYet') — surface the
      // failure loudly instead of letting the client believe it succeeded.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Bundle created but merge_bundles write failed: ${message}`, bundle: toDto(row) }, 502);
    }
  }

  return c.json({ bundle: toDto(row) }, 201);
});

// PUT /api/bundles/:id — partial update, scoped to the caller's shop (404 when missing).
bundleRoutes.put('/api/bundles/:id', async (c) => {
  const bundleRepo = new BundleRepository(createDb(c.env.DB));
  const id = c.req.param('id');
  const shopId = c.get('shopId');

  const existing = await bundleRepo.find(shopId, id);
  if (!existing) return c.json({ error: 'Bundle not found' }, 404);

  const body = await c.req.json<Partial<BundleInput>>();

  // Effective operation/items after this PUT is applied — reject before any
  // write if the result would be an expand bundle with zero items (see the
  // matching guard in POST for why: an empty composition_v2 aborts the
  // Rust cart-transform function entirely).
  const effectiveOperation = body.operation ?? existing.operation;
  const effectiveItems = body.items ?? (JSON.parse(existing.items) as BundleItem[]);
  if (effectiveOperation === 'expand' && effectiveItems.length === 0) {
    return c.json({ error: 'An expand bundle needs at least one component item.' }, 400);
  }

  // Mirrors the POST guard: a merge bundle with no price would fall back to
  // `?? 0` in Phase 2 below, silently becoming a 100%-off (free) line on the
  // Rust side, and a merge bundle with no parent variant has nothing to
  // merge into. The effective value is whichever this PUT sets, or (if this
  // PUT doesn't touch that field) whatever the existing row already has.
  if (effectiveOperation === 'merge') {
    const effectivePrice = body.price !== undefined ? body.price : toDollars(existing.price);
    if (typeof effectivePrice !== 'number' || !Number.isFinite(effectivePrice) || effectivePrice <= 0) {
      return c.json({ error: 'A merge bundle needs a price.' }, 400);
    }
    const effectiveParentVariantId =
      body.parentVariantId !== undefined ? body.parentVariantId : existing.parentVariantId;
    if (!effectiveParentVariantId) {
      return c.json({ error: 'A merge bundle needs a parent variant.' }, 400);
    }
  }

  const updatedAt = new Date().toISOString();

  const patch: Partial<Row> = { updatedAt };
  if (body.name !== undefined) patch.name = body.name;
  if (body.operation !== undefined) patch.operation = body.operation;
  if (body.items !== undefined) patch.items = JSON.stringify(body.items);
  if (body.parentVariantId !== undefined) patch.parentVariantId = body.parentVariantId;
  if (body.price !== undefined) patch.price = toCents(body.price);
  if (body.sumOfItems !== undefined) patch.sumOfItems = toCents(body.sumOfItems);
  if (body.status !== undefined) patch.status = body.status;

  await bundleRepo.update(shopId, id, patch);

  const merged: Row = { ...existing, ...patch };

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
  const compositionInputsChanged = body.items !== undefined || body.parentVariantId !== undefined;
  const mergeInputsChanged =
    body.items !== undefined ||
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
    await bundleRepo.setMetafieldState(shopId, id, 'Cleared', null);
  } else if (prevOp === 'merge' && newOp !== 'merge' && existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to remove merge_bundles entry for bundle ${id} on operation change:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await bundleRepo.setMetafieldState(shopId, id, 'Cleared', null);
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
      const { metafieldGid } = await writeComposition(c.env, shopDomain, merged.parentVariantId, effectiveItems);
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(shopId, id, 'Written', metafieldGid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Bundle updated but composition_v2 write failed: ${message}`, bundle: toDto(merged) },
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
        price: toDollars(merged.price)!,
        items: effectiveItems,
        title: merged.name,
      });
      const { metafieldGid } = await upsertMergeConfig(c.env, shopDomain, entry);
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await bundleRepo.setMetafieldState(shopId, id, 'Written', metafieldGid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Bundle updated but merge_bundles write failed: ${message}`, bundle: toDto(merged) },
        502,
      );
    }
  }

  return c.json({ bundle: toDto(merged) });
});

// DELETE /api/bundles/:id — scoped to the caller's shop (404 when missing).
bundleRoutes.delete('/api/bundles/:id', async (c) => {
  const bundleRepo = new BundleRepository(createDb(c.env.DB));
  const id = c.req.param('id');
  const shopId = c.get('shopId');

  const existing = await bundleRepo.find(shopId, id);
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

  await bundleRepo.delete(shopId, id);

  return c.json({ ok: true });
});
