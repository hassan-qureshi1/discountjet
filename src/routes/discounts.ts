import { Hono } from 'hono';
import type { DiscountRow } from '../db/repositories';
import { getSyncHealth, reconcileDiscounts } from '../lifecycle/discountSync';
import { adminGraphql } from '../lib/graphqlAdmin';
import { getAdapter } from '../lib/discountEngines/adapters';
import { resolveDiscountFunctionId } from '../lib/discountFunctions';
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

const DISCOUNT_AUTOMATIC_APP_CREATE = /* GraphQL */ `
  mutation CreateAppDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

interface CreateBody {
  slug?: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
  form?: unknown;
}

interface DiscountCreateResult {
  discountAutomaticAppCreate: {
    automaticAppDiscount: { discountId: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
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
  if (!body.title || !body.title.trim()) return c.json({ error: 'title is required' }, 400);
  if (!body.startsAt) return c.json({ error: 'startsAt is required' }, 400);
  // Guards the shape only. A throw from `validate` on a well-formed but invalid
  // form is still a 500 by design, so this must not become a try/catch there.
  if (body.form === undefined || body.form === null || typeof body.form !== 'object') {
    return c.json({ error: 'form is required' }, 400);
  }

  const template = await c.get('repos').templates.findBySlug(body.slug);
  if (!template) return c.json({ error: 'Template not found' }, 404);

  const adapter = getAdapter(template.type);
  const form = body.form as never;

  const errors = adapter.validate(form);
  if (errors.length > 0) return c.json({ error: errors.join(' '), errors }, 400);

  let value: string;
  try {
    value = adapter.serialize(form);
  } catch (err) {
    return c.json({ error: `Could not build the discount configuration: ${String(err)}` }, 400);
  }

  // `validate` passed on the FORM, but the builder drops rules it cannot
  // resolve (e.g. a `product_id` tier whose items only carry `variantId`).
  // Without this the mutation succeeds and the merchant gets a live promotion
  // that does nothing at checkout, with no error anywhere.
  if (!adapter.isActionable(JSON.parse(value))) {
    return c.json(
      {
        error:
          'This promotion has no usable rules. Check that each tier has products selected and a numeric discount value.',
      },
      400,
    );
  }

  const sizeBytes = new TextEncoder().encode(value).length;
  if (sizeBytes > adapter.maxBytes) {
    return c.json(
      { error: `Discount configuration is too large (${(sizeBytes / 1024).toFixed(1)}KB). Maximum size is 10KB.` },
      400,
    );
  }

  const shopDomain = requireShopDomain(c);

  let functionId: string;
  try {
    functionId = await resolveDiscountFunctionId(c.env, shopDomain, adapter.functionHandle);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  const res = await adminGraphql<DiscountCreateResult>(shopDomain, c.env, DISCOUNT_AUTOMATIC_APP_CREATE, {
    discount: {
      title: body.title,
      functionId,
      // Required by Shopify for a `discounts`-API-type function — without it
      // the mutation fails with "Functions configured to use the `discounts`
      // API type require the discountClasses field to be set." Comes from the
      // adapter because it is a property of what that function emits.
      discountClasses: adapter.discountClasses,
      startsAt: body.startsAt,
      ...(body.endsAt ? { endsAt: body.endsAt } : {}),
      ...(body.combinesWith ? { combinesWith: body.combinesWith } : {}),
      metafields: [{ namespace: adapter.namespace, key: adapter.key, type: 'json', value }],
    },
  });

  if (res.errors && res.errors.length > 0) {
    return c.json({ error: `Shopify rejected the discount: ${JSON.stringify(res.errors)}` }, 502);
  }

  const userErrors = res.data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return c.json({ error: userErrors.map((e) => e.message).join(' ') }, 502);
  }

  const discountId = res.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
  if (!discountId) {
    return c.json({ error: 'Shopify returned no discount id' }, 502);
  }

  // No D1 write: Shopify is the source of truth and the `discounts/create`
  // webhook already mirrors into the `discount` table. Inserting here would
  // race that webhook.
  return c.json({ discountId });
});
