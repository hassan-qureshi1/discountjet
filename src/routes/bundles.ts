import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/db';
import { bundle } from '../db/schema';
import type { AppEnv } from '../types/env.d';

export const bundleRoutes = new Hono<AppEnv>();

type Row = typeof bundle.$inferSelect;

interface BundleItem {
  variantId: string;
  qty: number;
  priceAdjustment?: number;
  titleOverride?: string;
  imageOverride?: string;
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

// POST /api/bundles — create a bundle in Draft with no metafield written yet.
bundleRoutes.post('/api/bundles', async (c) => {
  const body = await c.req.json<BundleInput>();

  // Fail loudly on missing required fields — never mask with `?? ''`, but
  // return a proper JSON 4xx (not a thrown Error, which Hono's default
  // handler turns into a plain-text 500).
  if (!body.name) return c.json({ error: 'Bundle name is required' }, 400);
  if (!body.operation) return c.json({ error: 'Bundle operation is required' }, 400);
  if (!body.items) return c.json({ error: 'Bundle items are required' }, 400);

  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    shopId: c.get('shopId'),
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

  return c.json({ bundle: toDto({ ...existing, ...patch }) });
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

  await db.delete(bundle).where(and(eq(bundle.id, id), eq(bundle.shopId, shopId)));

  return c.json({ ok: true });
});
