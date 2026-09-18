import { Hono } from 'hono';
import { createDb } from '../db/db';
import type { DiscountRow } from '../db/repos/discountRepo';
import { getSyncHealth, reconcileDiscounts } from '../lifecycle/discountSync';
import type { AppEnv } from '../types/env.d';

export const discountRoutes = new Hono<AppEnv>();

// Maps our lowercase engine kind to the prototype UI's capitalized `type`,
// display symbol, and binary status — the exact `Discount` shape the app
// Discounts list/detail pages already render (discount-engine-ui/src/types).
const TYPE_LABEL = { tier: 'Tier', bundle: 'Bundle', special: 'Special' } as const;
const TYPE_SYMBOL = { tier: '%', bundle: '◱', special: '◨' } as const;

type Row = DiscountRow;

interface UiDiscount {
  id: string;
  name: string;
  symbol: string;
  type: 'Tier' | 'Bundle' | 'Special';
  status: 'Active' | 'Inactive';
  products: number;
  updated: string;
  campaignId?: string;
}

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

function toUi(row: Row): UiDiscount {
  const kind = (row.type ?? 'tier') as keyof typeof TYPE_LABEL;
  return {
    id: row.id,
    name: row.name,
    symbol: TYPE_SYMBOL[kind] ?? '%',
    type: TYPE_LABEL[kind] ?? 'Tier',
    status: row.status === 'active' ? 'Active' : 'Inactive',
    products: row.products,
    updated: relativeTime(row.updatedAt),
    ...(row.campaignId ? { campaignId: row.campaignId } : {}),
  };
}

type FilterId = 'all' | 'tier' | 'bundle' | 'special' | 'inactive';
const MATCHERS: Record<FilterId, (d: UiDiscount) => boolean> = {
  all: () => true,
  tier: (d) => d.type === 'Tier',
  bundle: (d) => d.type === 'Bundle',
  special: (d) => d.type === 'Special',
  inactive: (d) => d.status === 'Inactive',
};

// GET /api/discounts?status=all|tier|bundle|special|inactive
// Returns the caller's shop's non-tombstoned discounts in the UI `Discount`
// shape plus per-tab counts, so the tab badges render without a second call.
discountRoutes.get('/api/discounts', async (c) => {
  const discounts = c.get('repos').discounts;
  const rows = await discounts.listLive(c.get('shopId'));

  const all = rows.map(toUi);
  const counts = {
    all: all.length,
    tier: all.filter(MATCHERS.tier).length,
    bundle: all.filter(MATCHERS.bundle).length,
    special: all.filter(MATCHERS.special).length,
    inactive: all.filter(MATCHERS.inactive).length,
  };

  const status = (c.req.query('status') ?? 'all') as FilterId;
  const matcher = MATCHERS[status] ?? MATCHERS.all;
  return c.json({ discounts: all.filter(matcher), counts });
});

// GET /api/discounts/sync-health — last webhook, last reconcile, unknown-config
// count. Registered before /:id so "sync-health" isn't captured as an id.
discountRoutes.get('/api/discounts/sync-health', async (c) => {
  const db = createDb(c.env.DB);
  return c.json(await getSyncHealth(db, c.get('shopId')));
});

// POST /api/discounts/reconcile — re-sync from Shopify and tombstone rows deleted
// while offline. Idempotent: a run with no Shopify changes writes no new tombstones.
discountRoutes.post('/api/discounts/reconcile', async (c) => {
  const shopDomain = c.get('shopDomain');
  if (!shopDomain) return c.json({ error: 'Shop domain not found' }, 404);

  const result = await reconcileDiscounts({
    db: createDb(c.env.DB),
    env: c.env,
    shopId: c.get('shopId'),
    shopDomain,
  });
  return c.json(result);
});

// GET /api/discounts/:id — single row (404 when missing or tombstoned).
discountRoutes.get('/api/discounts/:id', async (c) => {
  const discounts = c.get('repos').discounts;
  const row = await discounts.find(c.get('shopId'), c.req.param('id'));

  if (!row || row.deletedAt) return c.json({ error: 'Discount not found' }, 404);
  // E4-3 contract: campaign summary when this row is campaign-owned. The campaign
  // table lands in E8; until then we cannot resolve a name, so return null. The
  // detail UI still renders the locked state from row.campaignId alone.
  return c.json({ discount: toUi(row), campaign: null });
});
