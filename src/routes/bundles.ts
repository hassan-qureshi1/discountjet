import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/db';
import { bundle, shopifyShop } from '../db/schema';
import type { AppEnv } from '../types/env.d';
import {
  writeComposition,
  clearComposition,
  mergeConfigEntry,
  upsertMergeConfig,
  removeMergeConfig,
} from '../lib/bundleMetafields';
import { adminGraphql } from '../lib/graphqlAdmin';
import { ensureCartTransform } from '../lib/cartTransformRegistration';

export const bundleRoutes = new Hono<AppEnv>();

type Row = typeof bundle.$inferSelect;

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
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(bundle)
    .where(eq(bundle.shopId, c.get('shopId')))
    .all();

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
    const shopDomain = await requireShopDomain(db, shopId);
    const result = await ensureCartTransform(c.env, shopDomain, db, shopId);
    if ('conflict' in result) {
      return c.json({ active: false, conflict: true });
    }
    return c.json({ active: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ active: false, error: message }, 500);
  }
});

// GET /api/bundles/:id — single row scoped to the caller's shop (404 when missing).
bundleRoutes.get('/api/bundles/:id', async (c) => {
  const db = createDb(c.env.DB);
  const row = await db
    .select()
    .from(bundle)
    .where(and(eq(bundle.id, c.req.param('id')), eq(bundle.shopId, c.get('shopId'))))
    .get();

  if (!row) return c.json({ error: 'Bundle not found' }, 404);
  return c.json({ bundle: toDto(row) });
});

// Resolves the caller's shop domain (needed to call the Admin API) from its
// app-internal shopId. Fails loudly rather than masking a missing domain.
async function requireShopDomain(db: ReturnType<typeof createDb>, shopId: string): Promise<string> {
  const shop = await db
    .select({ domain: shopifyShop.myshopifyDomain })
    .from(shopifyShop)
    .where(eq(shopifyShop.id, shopId))
    .get();
  if (!shop?.domain) {
    throw new Error(`[bundles] no myshopify domain on file for shopId=${shopId}`);
  }
  return shop.domain;
}

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
  const db = createDb(c.env.DB);
  const shopId = c.get('shopId');
  const row = await db
    .select()
    .from(bundle)
    .where(and(eq(bundle.id, c.req.param('id')), eq(bundle.shopId, shopId)))
    .get();

  if (!row) return c.json({ error: 'Bundle not found' }, 404);
  if (!row.parentVariantId) {
    return c.json({ error: 'This bundle has no parent variant to view.' }, 400);
  }

  // A fresh `createDb` call (rather than reusing `db` above) — the bundle
  // lookup and the shop-domain lookup select different shapes off different
  // tables, so they're kept as separate calls rather than threading one
  // `db` through both (unlike the POST/PUT paths, which reuse a single `db`
  // for insert/update calls that don't inspect row shape).
  const shopDomain = await requireShopDomain(createDb(c.env.DB), shopId);

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

  const db = createDb(c.env.DB);
  await db.insert(bundle).values(row);

  if (row.operation === 'expand' && row.parentVariantId) {
    try {
      const shopDomain = await requireShopDomain(db, shopId);
      const { metafieldGid } = await writeComposition(c.env, shopDomain, row.parentVariantId, body.items);
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await db
        .update(bundle)
        .set({ metafieldState: 'Written', metafieldGid })
        .where(and(eq(bundle.id, row.id), eq(bundle.shopId, shopId)));
    } catch (err) {
      // The row is already created (metafieldState='NotYet') — surface the
      // failure loudly instead of letting the client believe it succeeded.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Bundle created but composition_v2 write failed: ${message}`, bundle: toDto(row) }, 502);
    }
  } else if (row.operation === 'merge' && row.parentVariantId) {
    try {
      const shopDomain = await requireShopDomain(db, shopId);
      const entry = mergeConfigEntry({ parentVariantId: row.parentVariantId, price: body.price ?? 0, items: body.items, title: body.name });
      const { metafieldGid } = await upsertMergeConfig(c.env, shopDomain, entry);
      row.metafieldState = 'Written';
      row.metafieldGid = metafieldGid;
      await db
        .update(bundle)
        .set({ metafieldState: 'Written', metafieldGid })
        .where(and(eq(bundle.id, row.id), eq(bundle.shopId, shopId)));
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
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const shopId = c.get('shopId');

  const existing = await db
    .select()
    .from(bundle)
    .where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)))
    .get();
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

  const updatedAt = new Date().toISOString();

  const patch: Partial<Row> = { updatedAt };
  if (body.name !== undefined) patch.name = body.name;
  if (body.operation !== undefined) patch.operation = body.operation;
  if (body.items !== undefined) patch.items = JSON.stringify(body.items);
  if (body.parentVariantId !== undefined) patch.parentVariantId = body.parentVariantId;
  if (body.price !== undefined) patch.price = toCents(body.price);
  if (body.sumOfItems !== undefined) patch.sumOfItems = toCents(body.sumOfItems);
  if (body.status !== undefined) patch.status = body.status;

  await db.update(bundle).set(patch).where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));

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
      const shopDomain = await requireShopDomain(db, shopId);
      await clearComposition(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to clear composition_v2 for bundle ${id} on operation change:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await db
      .update(bundle)
      .set({ metafieldState: 'Cleared', metafieldGid: null })
      .where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));
  } else if (prevOp === 'merge' && newOp !== 'merge' && existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = await requireShopDomain(db, shopId);
      await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to remove merge_bundles entry for bundle ${id} on operation change:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await db
      .update(bundle)
      .set({ metafieldState: 'Cleared', metafieldGid: null })
      .where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));
  }

  // Phase 2 — write the NEW transport. A failure here surfaces as a 502
  // (the row's phase-1 clear, if any, already committed — never mask a
  // failed write by leaving the client thinking it succeeded).
  if (newOp === 'expand' && merged.parentVariantId && (newOp !== prevOp || compositionInputsChanged)) {
    try {
      const shopDomain = await requireShopDomain(db, shopId);
      const { metafieldGid } = await writeComposition(c.env, shopDomain, merged.parentVariantId, effectiveItems);
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await db
        .update(bundle)
        .set({ metafieldState: 'Written', metafieldGid })
        .where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Bundle updated but composition_v2 write failed: ${message}`, bundle: toDto(merged) },
        502,
      );
    }
  } else if (newOp === 'merge' && merged.parentVariantId && (newOp !== prevOp || mergeInputsChanged)) {
    try {
      const shopDomain = await requireShopDomain(db, shopId);
      const entry = mergeConfigEntry({
        parentVariantId: merged.parentVariantId,
        price: toDollars(merged.price) ?? 0,
        items: effectiveItems,
        title: merged.name,
      });
      const { metafieldGid } = await upsertMergeConfig(c.env, shopDomain, entry);
      merged.metafieldState = 'Written';
      merged.metafieldGid = metafieldGid;
      await db
        .update(bundle)
        .set({ metafieldState: 'Written', metafieldGid })
        .where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));
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
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const shopId = c.get('shopId');

  const existing = await db
    .select()
    .from(bundle)
    .where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)))
    .get();
  if (!existing) return c.json({ error: 'Bundle not found' }, 404);

  // Best-effort: clearing the metafield is not fatal to the delete — the
  // row is going away regardless, and a stale composition_v2/merge_bundles
  // entry is a lesser problem than blocking delete on Shopify being
  // reachable. Failures are logged, not surfaced to the client.
  if (existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = await requireShopDomain(db, shopId);
      if (existing.operation === 'expand') {
        await clearComposition(c.env, shopDomain, existing.parentVariantId);
      } else if (existing.operation === 'merge') {
        await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
      }
    } catch (err) {
      console.error(`[bundles] failed to clear metafield for bundle ${id}:`, err);
    }
  }

  await db.delete(bundle).where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));

  return c.json({ ok: true });
});
