import { Hono } from 'hono';
import type { DiscountRow } from '../db/repositories';
import { getSyncHealth, reconcileDiscounts } from '../lifecycle/discountSync';
import { createDiscountInShopify } from '../lib/createDiscount';
import { requireShopDomain } from '../lib/shopDomain';
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
  const rows = await discounts.listLive();

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
  return c.json(await getSyncHealth(c.get('repos'), c.get('shopId')));
});

// POST /api/discounts/reconcile — re-sync from Shopify and tombstone rows deleted
// while offline. Idempotent: a run with no Shopify changes writes no new tombstones.
discountRoutes.post('/api/discounts/reconcile', async (c) => {
  const shopDomain = c.get('shopDomain');
  if (!shopDomain) return c.json({ error: 'Shop domain not found' }, 404);

  const result = await reconcileDiscounts({
    repos: c.get('repos'),
    env: c.env,
    shopId: c.get('shopId'),
    shopDomain,
  });
  return c.json(result);
});

// GET /api/discounts/:id — single row (404 when missing or tombstoned).
discountRoutes.get('/api/discounts/:id', async (c) => {
  const discounts = c.get('repos').discounts;
  const row = await discounts.findById(c.req.param('id'));

  if (!row || row.deletedAt) return c.json({ error: 'Discount not found' }, 404);
  // E4-3 contract: campaign summary when this row is campaign-owned. The campaign
  // table lands in E8; until then we cannot resolve a name, so return null. The
  // detail UI still renders the locked state from row.campaignId alone.
  return c.json({ discount: toUi(row), campaign: null });
});

interface CreateBody {
  slug?: string;
  title?: string;
  /** 'automatic' (the default) or 'code'. The engine is the template's; this is
   *  only how the discount is TRIGGERED, so both share one config metafield. */
  method?: 'automatic' | 'code';
  code?: string;
  startsAt?: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
  form?: unknown;
}

/**
 * Create a discount from a template.
 *
 * Takes the merchant's FORM DATA, never a pre-built config. A client that could
 * hand us a finished config could hand us any config, and this one lands on a
 * real shopper's bill. For the same reason the ENGINE comes from the stored
 * template, not from the request body.
 */
discountRoutes.post('/api/discounts', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateBody;

  if (!body.slug) return c.json({ error: 'slug is required' }, 400);
  // Title is checked per method below: a code discount takes its title from its
  // code, so demanding one here would ask for a name that is then discarded.
  if (!body.startsAt) return c.json({ error: 'startsAt is required' }, 400);
  const method = body.method ?? 'automatic';
  if (method !== 'automatic' && method !== 'code') {
    return c.json({ error: "method must be 'automatic' or 'code'" }, 400);
  }
  // Rejected here rather than at Shopify: a code discount with no code is a
  // malformed request, and every other rejection on this route happens before
  // an Admin call.
  if (method === 'code' && !body.code?.trim()) {
    return c.json({ error: 'code is required for a discount-code promotion' }, 400);
  }
  if (method === 'automatic' && !body.title?.trim()) {
    return c.json({ error: 'title is required' }, 400);
  }

  // Guards the shape only. A throw from `validate` on a well-formed but invalid
  // form is still a 500 by design, so this must not become a try/catch there.
  if (body.form === undefined || body.form === null || typeof body.form !== 'object') {
    return c.json({ error: 'form is required' }, 400);
  }

  const template = await c.get('repos').templates.findBySlug(body.slug);
  if (!template) return c.json({ error: 'Template not found' }, 404);

  const shopDomain = requireShopDomain(c);

  const outcome = await createDiscountInShopify(c.env, shopDomain, {
    engineType: template.type,
    form: body.form,
    method,
    title: body.title,
    code: body.code,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    combinesWith: body.combinesWith,
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);

  // No D1 write: Shopify is the source of truth and the `discounts/create`
  // webhook already mirrors into the `discount` table. Inserting here would
  // race that webhook.
  return c.json({ discountId: outcome.discountId });
});
