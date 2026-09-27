import { describe, it, expect, vi, beforeEach } from 'vitest';

// Run the real Hono app in-process with the data + Shopify layers mocked, so
// the protected-route flow is exercised end-to-end with no real bindings or
// credentials (mirrors the mocking style of the other unit tests).
//
// The data layer is swapped at TWO seams, both in `db/repositories` and both
// called by `requireShop`: `createShopRepository` (unscoped, used to resolve
// the caller's shop during auth) and `createRepositories` (the shop-bound set
// it then puts on the context). Tests seed in-memory implementations and then
// assert on the rows that end up in them. Nothing here stubs a Drizzle query
// chain, so a handler can be refactored — different number of queries,
// different order — without touching a test, as long as its behaviour holds.
vi.mock('./db/db', () => ({
  createDb: vi.fn(),
}));
vi.mock('./db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/repositories')>()),
  createShopRepository: vi.fn(),
  createRepositories: vi.fn(),
}));
vi.mock('./shopify', () => ({
  createShopify: vi.fn(),
  createSessionStorage: vi.fn(),
}));
vi.mock('./lib/graphqlAdmin', () => ({
  adminGraphql: vi.fn(),
}));
vi.mock('./lib/cartTransformRegistration', () => ({
  ensureCartTransform: vi.fn(),
}));
vi.mock('./lib/metafieldDefinitions', () => ({
  removeCartTransformMetafieldDefinitions: vi.fn(),
  getMetafieldSetupStatus: vi.fn(),
}));

import { app } from './index';
import { createRepositories, createShopRepository } from './db/repositories';
import {
  createInMemoryRepositories,
  shopRow,
  type InMemoryRepositories,
} from './db/repositories/inMemory';
import type { ShopRow, BundleRow, BundleItemRow, DiscountRow, TemplateRow } from './db/repositories';
import { adminGraphql } from './lib/graphqlAdmin';
import { ensureCartTransform } from './lib/cartTransformRegistration';
import { removeCartTransformMetafieldDefinitions, getMetafieldSetupStatus } from './lib/metafieldDefinitions';

/** The installed shop every request in this file authenticates as. */
const SHOP = { id: 'shop-abc', myshopifyDomain: 'mystore.myshopify.com', currency: 'USD' };

/**
 * Installs an in-memory data layer for the next request and hands it back so
 * the test can read the resulting rows. Seeded with `SHOP` unless a test
 * supplies its own shops (the plan-cache tests need extra columns set).
 */
function seed(rows: {
  shops?: ShopRow[];
  bundles?: BundleRow[];
  bundleItems?: BundleItemRow[];
  discounts?: DiscountRow[];
  templates?: TemplateRow[];
} = {}): InMemoryRepositories {
  const repos = createInMemoryRepositories(SHOP.id, {
    // Plus by default: most tests here are not about plan gating, and several
    // use `operation: 'update'` precisely BECAUSE it sidesteps the merge
    // guards. The plan-gating tests seed their own shop explicitly.
    shops: [shopRow({ ...SHOP, status: 'installed', planName: 'Shopify Plus' })],
    ...rows,
  });
  // Auth resolves the shop through the unscoped repository; the handlers then
  // use the shop-bound set. Both come from the same fakes, so a row written
  // through one is visible through the other.
  vi.mocked(createShopRepository).mockReturnValue(repos.shops);
  vi.mocked(createRepositories).mockReturnValue(repos);
  return repos;
}

/** A complete `bundle` row; override only what the test is about. */
const bundleRow = (overrides: Partial<BundleRow> = {}): BundleRow => ({
  id: 'bundle-1',
  shopId: SHOP.id,
  name: 'Camp Kit',
  operation: 'merge',
  parentVariantId: null,
  price: 2999, // minor units => $29.99
  metafieldState: 'NotYet',
  metafieldGid: null,
  scheduleStart: null,
  scheduleEnd: null,
  scheduleError: null,
  status: 'Draft',
  blockOnFailure: 0,
  campaignId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

/** A complete `bundle_item` row. */
const bundleItemRow = (overrides: Partial<BundleItemRow> = {}): BundleItemRow => ({
  id: 'item-1',
  shopId: SHOP.id,
  bundleId: 'bundle-1',
  variantId: 'gid://shopify/ProductVariant/1',
  name: 'Blue T-Shirt / Large',
  qty: 2,
  price: 1500, // minor units => $15.00
  priceAdjustment: null,
  titleOverride: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

/**
 * The Admin `nodes` payload `resolveVariants` reads. Every bundle save now
 * re-resolves its items' prices through it, so a POST/PUT carrying items makes
 * this call FIRST, before any metafield read or write.
 */
const variantNode = (
  overrides: { id?: string; title?: string; price?: string; productTitle?: string } = {},
) => ({
  id: overrides.id ?? 'gid://shopify/ProductVariant/1',
  title: overrides.title ?? 'Large',
  price: overrides.price ?? '15.00',
  image: null,
  product: {
    id: 'gid://shopify/Product/9',
    title: overrides.productTitle ?? 'Blue T-Shirt',
    featuredImage: null,
  },
});

/**
 * The bundle's TARGET variant, as the same `nodes` call returns it. A save now
 * resolves the target alongside the items in ONE call, so any test that saves a
 * bundle carrying a `parentVariantId` has to supply this too — otherwise the
 * target reads as deleted and the save is correctly rejected.
 */
const parentNode = (id: string) =>
  variantNode({ id, title: 'Bundle', productTitle: 'Camp Kit Bundle' });

/** Queues the next `adminGraphql` call to answer the variant-resolution query. */
const mockVariantResolution = (nodes: unknown[]) => {
  vi.mocked(adminGraphql).mockResolvedValueOnce({ data: { nodes } } as never);
};

/** A complete `discount` mirror row. */
const discountRow = (overrides: Partial<DiscountRow> = {}): DiscountRow => ({
  id: 'disc-1',
  shopId: SHOP.id,
  shopifyGid: 'gid://shopify/DiscountNode/1',
  name: 'Summer Volume',
  type: 'tier',
  method: 'automatic',
  status: 'active',
  products: 3,
  campaignId: null,
  deletedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

// The DB/KV/R2 bindings are mocked above and never read on this path, so we
// pass only the variable the auth fallback actually checks.
const env = (environment: 'development' | 'production') => ({ ENVIRONMENT: environment });

describe('GET /api/example (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 for unauthenticated requests', async () => {
    seed({ shops: [] }); // no installed shop -> auth cannot resolve one
    const res = await app.request('/api/example', {}, env('development'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the shop profile for an installed shop via the dev header fallback', async () => {
    seed({
      shops: [shopRow({ ...SHOP, name: 'Test Store', shopOwner: 'Jane Merchant', status: 'installed' })],
    });
    const res = await app.request(
      '/api/example',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      shop: { name: string; owner: string; status: string };
    };
    expect(json.shop.name).toBe('Test Store');
    expect(json.shop.owner).toBe('Jane Merchant');
    expect(json.shop.status).toBe('installed');
  });

  it('ignores the dev header fallback when ENVIRONMENT is not development', async () => {
    seed();
    const res = await app.request(
      '/api/example',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('production'),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/discounts/:id (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the discount plus a null campaign summary', async () => {
    seed({ discounts: [discountRow()] });
    const res = await app.request(
      '/api/discounts/disc-1',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { discount: { id: string; name: string; type: string }; campaign: null };
    expect(json.discount.id).toBe('disc-1');
    expect(json.discount.name).toBe('Summer Volume');
    expect(json.discount.type).toBe('Tier'); // toUi capitalizes the engine kind
    expect(json.campaign).toBeNull();
  });

  it('returns 404 for a tombstoned/missing discount', async () => {
    seed(); // no discounts seeded
    const res = await app.request(
      '/api/discounts/ghost',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/shop/plan (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries adminGraphql and returns updateOpEligible=true for a Shopify Plus store', async () => {
    // Plan columns unset -> the route must hit the Admin API and cache them.
    const repos = seed({ shops: [shopRow({ ...SHOP })] });
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { shop: { plan: { shopifyPlus: true, partnerDevelopment: false, displayName: 'Shopify Plus' } } },
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updateOpEligible: true, planName: 'Shopify Plus', currencyCode: 'USD' });
    expect(adminGraphql).toHaveBeenCalledTimes(1);
    // The plan signals are cached back onto the shop row, not just returned.
    expect(repos.shops.rows[0]).toMatchObject({
      shopifyPlus: 1,
      partnerDevelopment: 0,
      planName: 'Shopify Plus',
    });
  });

  it('returns updateOpEligible=false for a partner DEVELOPMENT store', async () => {
    // Shopify's own rule is broader than ours: "development stores or stores
    // on a Shopify Plus plan" can use lineUpdate. We gate on `shopify_plus`
    // alone, because the cart-transform function implements no lineUpdate
    // pass — so offering `update` on a dev store let a merchant save a bundle
    // that silently did nothing at checkout.
    seed({ shops: [shopRow({ ...SHOP })] });
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        shop: {
          plan: { shopifyPlus: false, partnerDevelopment: true, displayName: 'Developer Preview' },
        },
      },
    } as never);

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updateOpEligible: false,
      planName: 'Developer Preview',
      currencyCode: 'USD',
    });
  });

  it('returns updateOpEligible=false for a CACHED partner development store', async () => {
    // The cached branch is a separate code path from the Admin query above and
    // had the same `|| partnerDevelopment` in it.
    seed({
      shops: [shopRow({
        ...SHOP,
        shopifyPlus: 0,
        partnerDevelopment: 1,
        planName: 'Developer Preview',
      })],
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updateOpEligible: false,
      planName: 'Developer Preview',
      currencyCode: 'USD',
    });
    // Served from the row, so Shopify is never asked.
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('queries adminGraphql and returns updateOpEligible=false for a Basic non-dev store', async () => {
    seed({ shops: [shopRow({ ...SHOP })] });
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { shop: { plan: { shopifyPlus: false, partnerDevelopment: false, displayName: 'Basic' } } },
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updateOpEligible: false, planName: 'Basic', currencyCode: 'USD' });
    expect(adminGraphql).toHaveBeenCalledTimes(1);
  });

  it('returns cached plan without calling adminGraphql when already cached', async () => {
    seed({
      shops: [shopRow({ ...SHOP, shopifyPlus: 1, partnerDevelopment: 0, planName: 'Shopify Plus' })],
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updateOpEligible: true, planName: 'Shopify Plus', currencyCode: 'USD' });
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('GET /api/shop/plan includes the shop currency', async () => {
    seed({
      shops: [
        shopRow({
          ...SHOP,
          status: 'installed',
          currency: 'AUD',
          shopifyPlus: 1,
          partnerDevelopment: 0,
          planName: 'Shopify Plus',
        }),
      ],
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    const json = (await res.json()) as { currencyCode: string };
    expect(json.currencyCode).toBe('AUD');
  });

  it('returns 404 when the shop row/domain is missing', async () => {
    // The row is gone between auth resolving it and the route reading it —
    // the only way this 404 is reachable, since auth matched on its domain.
    const repos = seed();
    repos.shops.findById = async () => null;

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });
});

describe('Bundle CRUD API (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());


  it('GET /api/bundles returns bundles + summary with correct avgSaving math', async () => {
    const rows = [
      bundleRow({ id: 'bundle-1', price: 2999 }), // sumOfItems 3999 => saving $10.00
      bundleRow({ id: 'bundle-2', price: 1000 }), // sumOfItems 1500 => saving $5.00
    ];
    seed({
      bundles: rows,
      bundleItems: [
        bundleItemRow({ id: 'i1', bundleId: 'bundle-1', qty: 1, price: 3999 }),
        bundleItemRow({ id: 'i2', bundleId: 'bundle-2', qty: 1, price: 1500 }),
      ],
    });

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bundles: { id: string; price: { amount: string; currencyCode: string }; sumOfItems: { amount: string; currencyCode: string } }[];
      summary: { count: number; inCampaigns: number; avgSaving: { amount: string; currencyCode: string } };
    };
    expect(json.bundles).toHaveLength(2);
    expect(json.bundles[0].price).toEqual({ amount: '29.99', currencyCode: 'USD' });
    expect(json.bundles[0].sumOfItems).toEqual({ amount: '39.99', currencyCode: 'USD' });
    // mean(10.00, 5.00) = 7.50
    expect(json.summary).toEqual({ count: 2, inCampaigns: 0, avgSaving: { amount: '7.50', currencyCode: 'USD' } });
  });

  it('GET /api/bundles returns a null summary when empty', async () => {
    seed({ bundles: [] });

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bundles: unknown[]; summary: { count: number; inCampaigns: number; avgSaving: unknown } };
    expect(json.bundles).toEqual([]);
    expect(json.summary).toEqual({ count: 0, inCampaigns: 0, avgSaving: null });
  });

  it('GET /api/bundles computes sumOfItems from the item rows', async () => {
    seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', price: 2999 })],
      bundleItems: [
        bundleItemRow({ id: 'i1', bundleId: 'bundle-1', qty: 2, price: 1500 }),
        bundleItemRow({ id: 'i2', bundleId: 'bundle-1', variantId: 'gid://shopify/ProductVariant/2', name: 'Cap', qty: 1, price: 999 }),
      ],
    });

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    const json = (await res.json()) as { bundles: { sumOfItems: { amount: string; currencyCode: string } }[] };

    // 2 x 1500 + 1 x 999 = 3999
    expect(json.bundles[0].sumOfItems).toEqual({ amount: '39.99', currencyCode: 'AUD' });
  });

  it('GET /api/bundles/:id returns items ordered by name with MoneyV2 prices', async () => {
    seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1' })],
      bundleItems: [
        bundleItemRow({ id: 'i1', name: 'Zebra Mug', variantId: 'gid://shopify/ProductVariant/9', price: 500, qty: 1 }),
        bundleItemRow({ id: 'i2', name: 'Anchor Tee', variantId: 'gid://shopify/ProductVariant/8', price: 2000, qty: 1 }),
      ],
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    const json = (await res.json()) as { bundle: { items: { name: string; price: { amount: string } }[] } };

    expect(json.bundle.items.map((i) => i.name)).toEqual(['Anchor Tee', 'Zebra Mug']);
    expect(json.bundle.items[0].price).toEqual({ amount: '20.00', currencyCode: 'AUD' });
  });

  it('GET /api/bundles orders each bundle\'s items by name, straight from the repository', async () => {
    seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1' })],
      // Seeded out of order: the list route no longer re-sorts, so this
      // proves the repository's own ordering is what reaches the client.
      bundleItems: [
        bundleItemRow({ id: 'i1', name: 'Zebra Mug', variantId: 'gid://shopify/ProductVariant/9', price: 500, qty: 1 }),
        bundleItemRow({ id: 'i2', name: 'Anchor Tee', variantId: 'gid://shopify/ProductVariant/8', price: 2000, qty: 1 }),
      ],
    });

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    const json = (await res.json()) as { bundles: { items: { name: string }[] }[] };

    expect(json.bundles[0].items.map((i) => i.name)).toEqual(['Anchor Tee', 'Zebra Mug']);
  });

  it('GET /api/bundles reports a null sum for a bundle with no items', async () => {
    seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1' })],
      bundleItems: [],
    });

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    const json = (await res.json()) as { bundles: { sumOfItems: unknown }[] };

    expect(json.bundles[0].sumOfItems).toBeNull();
  });

  it('GET /api/bundles/:id returns 404 for missing/other-shop bundle', async () => {
    seed({ bundles: [bundleRow({ id: 'bundle-1', shopId: 'other-shop' })] });

    const res = await app.request(
      '/api/bundles/ghost',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/bundles inserts and returns 201 with minor-units<->MoneyV2 round-trip', async () => {
    const repos = seed();
    // Even an `update` bundle re-resolves its items: the price that lands in
    // `bundle_item` is Shopify's, never the client's.
    mockVariantResolution([variantNode({ price: '15.00' })]);

    // `operation: 'update'` — this test is only about the minor-units<->MoneyV2
    // round-trip, not merge-specific validation, so it deliberately avoids
    // the merge guards (which require a price + parentVariantId) and any
    // metafield write.
    const body = {
      name: 'Camp Kit',
      operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
      price: 29.99,
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      bundle: {
        id: string;
        name: string;
        price: { amount: string; currencyCode: string } | null;
        sumOfItems: unknown;
        status: string;
        metafieldState: string;
        items: unknown[];
      };
    };
    expect(json.bundle.id).toBeTruthy();
    expect(json.bundle.name).toBe('Camp Kit');
    expect(json.bundle.price).toEqual({ amount: '29.99', currencyCode: 'USD' });
    // 2 x $15.00, resolved from Shopify and summed from the persisted rows.
    expect(json.bundle.sumOfItems).toEqual({ amount: '30.00', currencyCode: 'USD' });
    // No schedule bounds means "permanently live", so a create with no window
    // derives `Active`. There is no `Draft` default any more — `Draft` is now
    // only ever the merchant's explicit manual off-switch.
    expect(json.bundle.status).toBe('Active');
    expect(json.bundle.metafieldState).toBe('NotYet');
    expect(json.bundle.items).toEqual([
      {
        variantId: 'gid://shopify/ProductVariant/1',
        name: 'Blue T-Shirt / Large',
        qty: 2,
        price: { amount: '15.00', currencyCode: 'USD' },
      },
    ]);
    // The row is really in the store, scoped to the caller's shop.
    expect(repos.bundles.rows).toHaveLength(1);
    expect(repos.bundles.rows[0]).toMatchObject({ shopId: SHOP.id, name: 'Camp Kit', price: 2999 });
    // ...and so are its components, in minor units, scoped to the same shop.
    expect(repos.bundleItems.rows).toHaveLength(1);
    expect(repos.bundleItems.rows[0]).toMatchObject({
      shopId: SHOP.id,
      bundleId: repos.bundles.rows[0].id,
      variantId: 'gid://shopify/ProductVariant/1',
      name: 'Blue T-Shirt / Large',
      qty: 2,
      price: 1500,
      priceAdjustment: null,
    });
  });

  it('POST /api/bundles returns 400 with a JSON error when name is missing', async () => {
    seed();

    const body = {
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toEqual(expect.any(String));
  });

  it('POST /api/bundles returns 400 with a JSON error when an expand bundle has no items', async () => {
    seed();

    const body = {
      name: 'Camp Kit',
      operation: 'expand',
      items: [],
      parentVariantId: 'gid://shopify/ProductVariant/1',
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toEqual(expect.any(String));
  });

  it('PUT /api/bundles/:id updates and returns 200 with minor-units<->MoneyV2 round-trip', async () => {
    // `operation: 'update'` — this test is only about the minor-units<->MoneyV2
    // round-trip, not merge-specific validation, so it deliberately avoids
    // the merge guards (which require a price + parentVariantId) and any
    // metafield write.
    const repos = seed({ bundles: [bundleRow({ operation: 'update' })] });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ price: 19.99 }),
      },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bundle: { id: string; price: { amount: string; currencyCode: string } | null; updated: string };
    };
    expect(json.bundle.id).toBe('bundle-1');
    expect(json.bundle.price).toEqual({ amount: '19.99', currencyCode: 'USD' });
    expect(json.bundle.updated).toBe('Just now');
    expect(repos.bundles.rows[0].price).toBe(1999); // persisted in minor units
  });

  it('PUT /api/bundles/:id returns 404 for missing/other-shop bundle', async () => {
    seed({ bundles: [bundleRow({ id: 'bundle-1', shopId: 'other-shop' })] });

    const res = await app.request(
      '/api/bundles/ghost',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ price: 19.99 }),
      },
      env('development'),
    );
    expect(res.status).toBe(404);
  });

  it('DELETE /api/bundles/:id deletes and returns 200 { ok: true }', async () => {
    const repos = seed({ bundles: [bundleRow()] });

    const res = await app.request(
      '/api/bundles/bundle-1',
      { method: 'DELETE', headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(repos.bundles.rows).toHaveLength(0);
  });

  it('DELETE /api/bundles/:id returns 404 for missing/other-shop bundle', async () => {
    seed({ bundles: [bundleRow({ id: 'bundle-1', shopId: 'other-shop' })] });

    const res = await app.request(
      '/api/bundles/ghost',
      { method: 'DELETE', headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/bundles writes composition for an expand bundle with a parentVariantId', async () => {
    const repos = seed();
    mockVariantResolution([variantNode({ price: '15.00' }), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        metafieldsSet: {
          metafields: [{ id: 'gid://shopify/Metafield/1' }],
          userErrors: [],
        },
      },
    });

    const body = {
      name: 'Ski Set',
      operation: 'expand',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2, price: 10 }],
      parentVariantId: 'gid://shopify/ProductVariant/999',
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { bundle: { metafieldState: string; metafieldGid?: string } };
    expect(json.bundle.metafieldState).toBe('Written');
    expect(json.bundle.metafieldGid).toBe('gid://shopify/Metafield/1');
    // The response and the stored row agree — the post-write update landed.
    expect(repos.bundles.rows[0]).toMatchObject({
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
    });

    // Call 0 resolves the variants; call 1 writes the metafield.
    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[1];
    expect(query).toContain('metafieldsSet');
    expect(variables).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'composition' })],
    });
    // The client claimed $10; the composition the Rust function reads says $15.
    const written = JSON.parse(
      (variables as { metafields: { value: string }[] }).metafields[0].value,
    ) as { id: string; quantity: number; price: number }[];
    expect(written).toEqual([
      { id: 'gid://shopify/ProductVariant/1', quantity: 2, price: 15 },
    ]);
    expect(repos.bundleItems.rows[0]).toMatchObject({ price: 1500, qty: 2 });
  });

  it('POST /api/bundles writes $app:cart-transform.merge_bundles (never composition) for a merge bundle', async () => {
    const repos = seed();
    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/2' }], userErrors: [] } },
      });

    const body = {
      name: 'Camp Kit',
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
      parentVariantId: 'gid://shopify/ProductVariant/999',
      price: 29.99,
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { bundle: { metafieldState: string } };
    expect(json.bundle.metafieldState).toBe('Written');
    expect(repos.bundles.rows[0]).toMatchObject({
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/2',
    });

    // Call 0 resolves the variants, then the merge config read + write.
    expect(adminGraphql).toHaveBeenCalledTimes(3);
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[2];
    expect(writeQuery).toContain('metafieldsSet');
    expect(writeVars).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'merge_bundles' })],
    });
    expect(writeVars).not.toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'composition' })],
    });
  });

  it('POST /api/bundles returns 400 with a JSON error when a merge bundle has no price', async () => {
    seed();

    const body = {
      name: 'Camp Kit',
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
      parentVariantId: 'gid://shopify/ProductVariant/999',
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('A merge bundle needs a price.');
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles returns 400 with a JSON error when a merge bundle has no parentVariantId', async () => {
    seed();

    const body = {
      name: 'Camp Kit',
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
      price: 29.99,
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('A merge bundle needs a parent variant.');
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles writes $app:cart-transform.merge_bundles for a merge bundle with a parentVariantId', async () => {
    const repos = seed();
    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } })
      .mockResolvedValueOnce({
        data: {
          metafieldsSet: {
            metafields: [{ id: 'gid://shopify/Metafield/2' }],
            userErrors: [],
          },
        },
      });

    const body = {
      name: 'Camp Kit',
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
      parentVariantId: 'gid://shopify/ProductVariant/999',
      price: 9.99,
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { bundle: { metafieldState: string; metafieldGid?: string } };
    expect(json.bundle.metafieldState).toBe('Written');
    expect(json.bundle.metafieldGid).toBe('gid://shopify/Metafield/2');
    expect(repos.bundles.rows[0]).toMatchObject({
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/2',
    });

    // Call 0 resolves the variants, then the merge config read + write.
    expect(adminGraphql).toHaveBeenCalledTimes(3);
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[2];
    expect(writeQuery).toContain('metafieldsSet');
    expect(writeVars).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'merge_bundles' })],
    });
  });

  it('POST /api/bundles returns a 502 JSON error when the metafield write fails', async () => {
    const repos = seed();
    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: ['metafields', '0', 'value'], message: 'bad value' }],
        },
      },
    });

    const body = {
      name: 'Ski Set',
      operation: 'expand',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2, price: 10 }],
      parentVariantId: 'gid://shopify/ProductVariant/999',
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toEqual(expect.any(String));
    // The row is created even though the metafield write failed, and its
    // state still says nothing was written — never a false `Written`.
    expect(repos.bundles.rows).toHaveLength(1);
    expect(repos.bundles.rows[0]).toMatchObject({ metafieldState: 'NotYet', metafieldGid: null });
    // ...and so are its verified components: `replaceForBundle` commits before
    // the metafield write is attempted, so a Shopify-side failure never leaves
    // a bundle with no components.
    expect(repos.bundleItems.rows).toHaveLength(1);
    expect(repos.bundleItems.rows[0]).toMatchObject({
      bundleId: repos.bundles.rows[0].id,
      variantId: 'gid://shopify/ProductVariant/1',
      price: 1500,
      qty: 2,
    });
  });

  it('POST /api/bundles persists scheduleError on the row when the metafield write fails', async () => {
    // An always-on (no window) expand bundle: the due-scan never revisits a
    // row with no `scheduleStart`/`scheduleEnd`, so `scheduleError` is the
    // only thing that will ever surface a failed metafield write to the
    // merchant. It must land on the STORED row, not just the response body.
    const repos = seed();
    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: ['metafields', '0', 'value'], message: 'bad value' }],
        },
      },
    });

    const body = {
      name: 'Ski Set',
      operation: 'expand',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2, price: 10 }],
      parentVariantId: 'gid://shopify/ProductVariant/999',
    };
    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { bundle: { scheduleError: string | null } };
    expect(json.bundle.scheduleError).toEqual(expect.any(String));
    // The persisted row and the 502 body must agree — never a lying pair.
    expect(repos.bundles.rows[0].scheduleError).toBe(json.bundle.scheduleError);
    expect(repos.bundles.rows[0].scheduleError).toContain('bad value');
  });

  it('POST /api/bundles overwrites the client price with Shopify\'s', async () => {
    const repos = seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });
    mockVariantResolution([variantNode({ price: '15.00' }), parentNode('gid://shopify/ProductVariant/7')]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } },
    });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'expand',
          parentVariantId: 'gid://shopify/ProductVariant/7',
          // A client claiming the item costs one cent.
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2, price: 0.01 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    expect(repos.bundleItems.rows[0].price).toBe(1500);
    expect(repos.bundleItems.rows[0].name).toBe('Blue T-Shirt / Large');
  });

  it('POST /api/bundles converts a major-unit priceAdjustment into minor units', async () => {
    const repos = seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });
    mockVariantResolution([variantNode({ price: '15.00' })]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [
            { variantId: 'gid://shopify/ProductVariant/1', qty: 1, priceAdjustment: 2.5, titleOverride: 'Freebie' },
          ],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    expect(repos.bundleItems.rows[0]).toMatchObject({
      priceAdjustment: 250,
      titleOverride: 'Freebie',
    });
  });

  it('POST /api/bundles rejects a body containing sumOfItems', async () => {
    seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'expand',
          parentVariantId: 'gid://shopify/ProductVariant/7',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
          sumOfItems: 99.99,
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/sumOfItems/);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles rejects a variant that does not exist', async () => {
    const repos = seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });
    mockVariantResolution([null, parentNode('gid://shopify/ProductVariant/7')]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'expand',
          parentVariantId: 'gid://shopify/ProductVariant/7',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/ProductVariant\/1/);
    // Nothing was created — an unverifiable price never becomes a row.
    expect(repos.bundles.rows).toHaveLength(0);
    expect(repos.bundleItems.rows).toHaveLength(0);
  });

  it('POST /api/bundles rejects an item id that is not a ProductVariant gid', async () => {
    seed();

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [{ variantId: 'gid://shopify/Product/456', qty: 1 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/Not ProductVariant ids/);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles surfaces a variant-resolution transport failure as a prefixed 502', async () => {
    seed();
    vi.mocked(adminGraphql).mockRejectedValueOnce(new Error('network down'));

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    // Prefixed exactly once — the resolver adds it, the route does not repeat it.
    expect(json.error).toBe('Failed to resolve variants: network down');
  });

  it('PUT /api/bundles/:id keeps a deleted variant\'s stored price and name', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'expand', parentVariantId: 'gid://shopify/ProductVariant/7', metafieldState: 'NotYet' })],
      bundleItems: [
        bundleItemRow({
          id: 'i1',
          bundleId: 'bundle-1',
          variantId: 'gid://shopify/ProductVariant/1',
          name: 'Blue T-Shirt / Large',
          price: 1500,
          qty: 2,
        }),
      ],
    });
    mockVariantResolution([null, parentNode('gid://shopify/ProductVariant/7')]);
    // The seeded bundle is `Draft`, so the transport gate skips the composition
    // rewrite entirely — only the resolution call is made.

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        // The body DOES resend the items — that is what makes this the
        // re-resolution path, where the variant comes back deleted.
        body: JSON.stringify({
          name: 'Renamed',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const kept = repos.bundleItems.rows.find((r) => r.variantId === 'gid://shopify/ProductVariant/1');
    expect(kept?.price).toBe(1500);
    expect(kept?.name).toBe('Blue T-Shirt / Large');
  });

  it('PUT /api/bundles/:id leaves the stored item rows byte-identical when the body sends no items', async () => {
    const stored = bundleItemRow({
      id: 'i1',
      bundleId: 'bundle-1',
      price: 1500,
      qty: 2,
      priceAdjustment: 250, // already minor units: $2.50
      titleOverride: 'Freebie',
    });
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'update' })],
      bundleItems: [{ ...stored }],
    });
    // Deliberately no `mockVariantResolution` here: Shopify is never asked, and
    // an unconsumed `mockResolvedValueOnce` would leak into the next test.

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    // Same id (no `replaceForBundle` churn), same price (no silent re-pricing
    // behind the composition metafield's back), same already-minor adjustment
    // (never run through toMinorUnits a second time into 25000).
    expect(repos.bundleItems.rows).toEqual([stored]);
    expect(adminGraphql).not.toHaveBeenCalled();

    // The response reports those same untouched rows.
    const json = (await res.json()) as {
      bundle: { items: { price: { amount: string } }[]; sumOfItems: { amount: string } };
    };
    expect(json.bundle.items[0].price).toEqual({ amount: '15.00', currencyCode: 'AUD' });
    expect(json.bundle.sumOfItems).toEqual({ amount: '30.00', currencyCode: 'AUD' });
  });

  it('PUT /api/bundles/:id converts a major-unit priceAdjustment when the body DOES send items', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'update' })],
      bundleItems: [bundleItemRow({ id: 'i1', bundleId: 'bundle-1', priceAdjustment: 250 })],
    });
    mockVariantResolution([variantNode({ price: '15.00' })]);

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 3, priceAdjustment: 1.25 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(repos.bundleItems.rows[0]).toMatchObject({ priceAdjustment: 125, qty: 3, price: 1500 });
  });

  // ---------------------------------------------------------------------
  // Request-body preconditions. The bundle total is COMPUTED as
  // `sum(price * qty)` and the metafield is built from the same rows, so a
  // junk `qty`, a duplicate variant or a non-array `items` corrupts money (or
  // 500s) rather than being cosmetic. Each of these must be a 400 whose
  // message NAMES the offending value — a future refactor must not be able to
  // quietly turn one back into a 500.
  // ---------------------------------------------------------------------

  it('POST /api/bundles rejects a fractional qty, naming the variant and the value', async () => {
    const repos = seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2.6 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/gid:\/\/shopify\/ProductVariant\/1/);
    expect(error).toMatch(/2\.6/);
    // Rejected before Shopify is asked, and nothing was written.
    expect(adminGraphql).not.toHaveBeenCalled();
    expect(repos.bundles.rows).toHaveLength(0);
    expect(repos.bundleItems.rows).toHaveLength(0);
  });

  it('POST /api/bundles rejects a zero/negative/non-numeric qty', async () => {
    for (const qty of [0, -1, 'two', null]) {
      vi.clearAllMocks();
      seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });

      const res = await app.request(
        '/api/bundles',
        {
          method: 'POST',
          headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Camp Kit',
            operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
            items: [{ variantId: 'gid://shopify/ProductVariant/1', qty }],
          }),
        },
        env('development'),
      );

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toMatch(/whole number greater than zero/);
      expect(error).toContain(String(qty));
      expect(adminGraphql).not.toHaveBeenCalled();
    }
  });

  it('PUT /api/bundles/:id rejects a fractional qty rather than storing it', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'update' })],
      bundleItems: [bundleItemRow({ id: 'i1', bundleId: 'bundle-1', qty: 2 })],
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2.6 }] }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/2\.6/);
    expect(repos.bundleItems.rows[0].qty).toBe(2);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('PUT /api/bundles/:id rejects `items: null` and leaves the stored priceAdjustment untouched', async () => {
    // The bug this pins: `body.items ?? existingItems.map(...)` let `null`
    // fall through to the stored rows (priceAdjustment ALREADY in minor
    // units), while the gate `body.items !== undefined` was still TRUE for
    // `null` — so verifyItems re-ran toMinorUnits and turned 500 into 50000.
    const stored = bundleItemRow({
      id: 'i1',
      bundleId: 'bundle-1',
      qty: 2,
      price: 1500,
      priceAdjustment: 500, // already minor units: A$5.00
    });
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'update' })],
      bundleItems: [{ ...stored }],
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', items: null }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/items must be an array/i);
    // The stored adjustment is UNCHANGED — not 50000, and not merely "the
    // request succeeded".
    expect(repos.bundleItems.rows).toEqual([stored]);
    expect(repos.bundleItems.rows[0].priceAdjustment).toBe(500);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles rejects more items than the variant resolver will accept', async () => {
    seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });
    const items = Array.from({ length: 51 }, (_, i) => ({
      variantId: `gid://shopify/ProductVariant/${i + 1}`,
      qty: 1,
    }));

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Camp Kit', operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1', items }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/at most 50 items/);
    expect(error).toMatch(/51/);
    // Never reaches Shopify — that is the whole point of the cap.
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles rejects two rows for the same variant, naming the repeat', async () => {
    const repos = seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [
            { variantId: 'gid://shopify/ProductVariant/1', qty: 1 },
            { variantId: 'gid://shopify/ProductVariant/2', qty: 1 },
            { variantId: 'gid://shopify/ProductVariant/1', qty: 3 },
          ],
        }),
      },
      env('development'),
    );

    // A 400, not the 500 the (bundle_id, variant_id) unique index used to give.
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/Duplicate items/);
    expect(error).toMatch(/gid:\/\/shopify\/ProductVariant\/1/);
    expect(error).not.toMatch(/ProductVariant\/2/);
    expect(repos.bundleItems.rows).toHaveLength(0);
  });

  it('PUT /api/bundles/:id rejects two rows for the same variant', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'update' })],
      bundleItems: [bundleItemRow({ id: 'i1', bundleId: 'bundle-1' })],
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            { variantId: 'gid://shopify/ProductVariant/1', qty: 1 },
            { variantId: 'gid://shopify/ProductVariant/1', qty: 2 },
          ],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/gid:\/\/shopify\/ProductVariant\/1/);
    expect(repos.bundleItems.rows).toHaveLength(1);
  });

  it('POST /api/bundles rejects a non-array `items` with a 400, not a 500', async () => {
    seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })] });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Camp Kit', operation: 'update',
      parentVariantId: 'gid://shopify/ProductVariant/1', items: {} }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/items must be an array/i);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('PUT /api/bundles/:id rejects a non-array `items` with a 400, not a 500', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' , planName: 'Shopify Plus' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'update' })],
      bundleItems: [bundleItemRow({ id: 'i1', bundleId: 'bundle-1' })],
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ items: {} }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/items must be an array/i);
    expect(repos.bundleItems.rows).toHaveLength(1);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('PUT /api/bundles/:id rejects a body containing sumOfItems', async () => {
    seed({ bundles: [bundleRow({ operation: 'update' })] });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ sumOfItems: 99.99 }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/sumOfItems/);
  });

  it('GET /api/bundles/:id/admin-url resolves the parent variant\'s product into an admin URL', async () => {
    seed({ bundles: [bundleRow({ parentVariantId: 'gid://shopify/ProductVariant/999' })] });
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        productVariant: {
          id: 'gid://shopify/ProductVariant/999',
          product: { id: 'gid://shopify/Product/456' },
        },
      },
    });

    const res = await app.request(
      '/api/bundles/bundle-1/admin-url',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string };
    expect(json.url).toBe('https://mystore.myshopify.com/admin/products/456');
    expect(json.url).toContain('/admin/products/456');
  });

  it('GET /api/bundles/:id/admin-url returns 400 when the bundle has no parent variant', async () => {
    seed({ bundles: [bundleRow({ parentVariantId: null })] });

    const res = await app.request(
      '/api/bundles/bundle-1/admin-url',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('This bundle has no parent variant to view.');
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('GET /api/bundles/:id/admin-url returns 404 for missing/other-shop bundle', async () => {
    seed({ bundles: [bundleRow({ id: 'bundle-1', shopId: 'other-shop' })] });

    const res = await app.request(
      '/api/bundles/ghost/admin-url',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });

  it('GET /api/bundles/activation returns {active:true} when ensureCartTransform resolves a gid', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockResolvedValueOnce({ gid: 'gid://shopify/CartTransform/1', created: true });

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: true });
    expect(ensureCartTransform).toHaveBeenCalledTimes(1);
  });

  it('GET /api/bundles/activation returns {active:false, conflict:true} on a foreign transform', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockResolvedValueOnce({ conflict: true });

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, conflict: true });
  });

  it('GET /api/bundles/activation returns 500 { active:false, error } when ensureCartTransform throws', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockRejectedValueOnce(new Error('cart-transform function not deployed'));

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(500);
    const json = (await res.json()) as { active: boolean; error: string };
    expect(json.active).toBe(false);
    expect(json.error).toContain('cart-transform function not deployed');
  });

  it('GET /api/bundles/activation removes the app metafield definitions and reports the merge_bundles value status', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockResolvedValueOnce({ gid: 'gid://shopify/CartTransform/1', created: false });
    vi.mocked(removeCartTransformMetafieldDefinitions).mockResolvedValueOnce(undefined);
    vi.mocked(getMetafieldSetupStatus).mockResolvedValueOnce({
      mergeBundlesValuePresent: true,
    });

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true,
      metafields: { mergeBundlesValuePresent: true },
    });
    expect(removeCartTransformMetafieldDefinitions).toHaveBeenCalledWith(expect.anything(), 'mystore.myshopify.com');
    expect(getMetafieldSetupStatus).toHaveBeenCalledWith(expect.anything(), 'mystore.myshopify.com');
  });

  it('GET /api/bundles/activation reports mergeBundlesValuePresent false when no merge config has been written', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockResolvedValueOnce({ gid: 'gid://shopify/CartTransform/1', created: false });
    vi.mocked(removeCartTransformMetafieldDefinitions).mockResolvedValueOnce(undefined);
    vi.mocked(getMetafieldSetupStatus).mockResolvedValueOnce({
      mergeBundlesValuePresent: false,
    });

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true,
      metafields: { mergeBundlesValuePresent: false },
    });
  });

  it('GET /api/bundles/activation stays non-fatal when removeCartTransformMetafieldDefinitions throws', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockResolvedValueOnce({ gid: 'gid://shopify/CartTransform/1', created: false });
    vi.mocked(removeCartTransformMetafieldDefinitions).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getMetafieldSetupStatus).mockResolvedValueOnce({
      mergeBundlesValuePresent: true,
    });

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true,
      metafields: { mergeBundlesValuePresent: true },
    });
  });

  it('GET /api/bundles/activation omits metafields (rather than fabricating false) when the status check throws', async () => {
    seed();
    vi.mocked(ensureCartTransform).mockResolvedValueOnce({ gid: 'gid://shopify/CartTransform/1', created: false });
    vi.mocked(removeCartTransformMetafieldDefinitions).mockResolvedValueOnce(undefined);
    vi.mocked(getMetafieldSetupStatus).mockRejectedValueOnce(new Error('boom'));

    const res = await app.request(
      '/api/bundles/activation',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: true });
  });

  it('PUT /api/bundles/:id does not re-write composition on a rename-only update', async () => {
    // Already-Written expand bundle; a rename/status-only PUT (no `items` or
    // `parentVariantId` in the body) must not touch the metafield.
    const existing = bundleRow({
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/999',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
    });
    // The PUT body below carries no `items`, so the "expand needs at least
    // one item" guard falls back to whatever `bundle_item` rows already
    // exist for this bundle — needs at least one seeded here, or the guard
    // (correctly) rejects it.
    const repos = seed({ bundles: [existing], bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })] });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Kit' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { bundle: { name: string; metafieldState: string } };
    expect(json.bundle.name).toBe('Renamed Kit');
    expect(json.bundle.metafieldState).toBe('Written');
    // The rename persisted; the metafield bookkeeping was left untouched.
    expect(repos.bundles.rows[0]).toMatchObject({
      name: 'Renamed Kit',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
    });
    // No Admin traffic whatsoever. A body with no `items` has no client price
    // to verify, so the rows are not re-resolved — which is also what keeps
    // `bundle_item.price` and the composition metafield from diverging, since
    // the composition is deliberately not rewritten on a rename either.
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('PUT /api/bundles/:id persists scheduleError on the row when the metafield write fails', async () => {
    // Already-Active expand bundle whose composition was never (successfully)
    // written. A PUT that replaces `items` sets `compositionInputsChanged`,
    // which forces Phase 2 to attempt the write regardless of `becameLive` or
    // whether the operation itself changed.
    const existing = bundleRow({
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/999',
      metafieldState: 'NotYet',
      status: 'Active',
      // Below the parent's (mocked) $15.00 price — an expand bundle priced
      // above its target fails validation before the metafield write is
      // even attempted.
      price: 999,
    });
    const repos = seed({ bundles: [existing], bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })] });

    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: ['metafields', '0', 'value'], message: 'bad value' }],
        },
      },
    });

    const body = {
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2, price: 10 }],
    };
    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { bundle: { scheduleError: string | null } };
    expect(json.bundle.scheduleError).toEqual(expect.any(String));
    // The persisted row and the 502 body must agree — never a lying pair.
    expect(repos.bundles.rows[0].scheduleError).toBe(json.bundle.scheduleError);
    expect(repos.bundles.rows[0].scheduleError).toContain('bad value');
  });

  it('PUT /api/bundles/:id transitions expand -> merge: clears composition and writes $app:cart-transform.merge_bundles', async () => {
    const existing = bundleRow({
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/999',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
      price: 999,
      status: 'Active',
    });
    const repos = seed({ bundles: [existing] });

    // Call order: the variant resolution for the body's items, then
    // clearComposition (metafieldsDelete) for the OLD transport, then
    // upsertMergeConfig's read + write for the NEW transport.
    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          metafieldsDelete: {
            deletedMetafields: [{ key: 'composition', namespace: '$app:cart-transform', ownerId: 'gid://shopify/ProductVariant/999' }],
            userErrors: [],
          },
        },
      })
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/2' }], userErrors: [] } },
      });

    const body = {
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
      price: 9.99,
    };
    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { bundle: { operation: string; metafieldState: string; metafieldGid?: string } };
    expect(json.bundle.operation).toBe('merge');
    expect(json.bundle.metafieldState).toBe('Written');
    expect(json.bundle.metafieldGid).toBe('gid://shopify/Metafield/2');
    // The stored row tracks exactly one live transport — the new one.
    expect(repos.bundles.rows[0]).toMatchObject({
      operation: 'merge',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/2',
    });

    expect(adminGraphql).toHaveBeenCalledTimes(4);
    const [, , resolveQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(resolveQuery).toContain('nodes(ids: $ids)');
    const [, , clearQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(clearQuery).toContain('metafieldsDelete');
    const [, , readQuery] = vi.mocked(adminGraphql).mock.calls[2];
    expect(readQuery).toContain('merge_bundles');
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[3];
    expect(writeQuery).toContain('metafieldsSet');
    expect(writeVars).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'merge_bundles' })],
    });
  });

  it('PUT /api/bundles/:id merge -> merge with a changed parentVariantId: removes the OLD parent entry and writes the NEW one', async () => {
    const OLD_PARENT = 'gid://shopify/ProductVariant/999';
    const NEW_PARENT = 'gid://shopify/ProductVariant/111';
    const existing = bundleRow({
      operation: 'merge',
      parentVariantId: OLD_PARENT,
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
      price: 2999, // $29.99
      status: 'Active',
    });
    // A live bundle, so the transport gate lets Phase 2 write. Being live also
    // means the NEW target is verified first, which needs both a component row
    // (the price-below-components guard) and a resolution answer.
    const repos = seed({ bundles: [existing], bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })] });

    const oldEntry = {
      parentVariantId: OLD_PARENT,
      price: 29.99,
      sources: ['gid://shopify/ProductVariant/1'],
    };
    // Call order: the NEW target's resolution, then removeMergeConfig's
    // read + write for the OLD parent (Phase 1, the fix under test), then
    // upsertMergeConfig's read + write for the NEW parent (Phase 2).
    mockVariantResolution([parentNode(NEW_PARENT)]);
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify([oldEntry]) },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          metafieldsDelete: {
            deletedMetafields: [{ key: 'merge_bundles', namespace: '$app:cart-transform', ownerId: 'gid://shopify/Shop/1' }],
            userErrors: [],
          },
        },
      })
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/2' }], userErrors: [] } },
      });

    const body = { parentVariantId: NEW_PARENT };
    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bundle: { operation: string; parentVariantId?: string; metafieldState: string; metafieldGid?: string };
    };
    expect(json.bundle.operation).toBe('merge');
    expect(json.bundle.parentVariantId).toBe(NEW_PARENT);
    expect(json.bundle.metafieldState).toBe('Written');
    expect(json.bundle.metafieldGid).toBe('gid://shopify/Metafield/2');
    expect(repos.bundles.rows[0]).toMatchObject({
      parentVariantId: NEW_PARENT,
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/2',
    });

    // Phase 1 — the OLD parent's entry is removed (read + metafieldsDelete,
    // since it was the only entry in the array).
    expect(adminGraphql).toHaveBeenCalledTimes(5);
    const [, , removeReadQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(removeReadQuery).toContain('merge_bundles');
    const [, , removeWriteQuery] = vi.mocked(adminGraphql).mock.calls[2];
    expect(removeWriteQuery).toContain('metafieldsDelete');

    // Phase 2 — the NEW parent's entry is written.
    const [, , upsertReadQuery] = vi.mocked(adminGraphql).mock.calls[3];
    expect(upsertReadQuery).toContain('merge_bundles');
    const [, , upsertWriteQuery, upsertWriteVars] = vi.mocked(adminGraphql).mock.calls[4];
    expect(upsertWriteQuery).toContain('metafieldsSet');
    expect(upsertWriteVars).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'merge_bundles' })],
    });
  });

  it('PUT /api/bundles/:id transitions merge -> update: removes the checkout.merge_bundles entry and writes nothing new', async () => {
    const existing = bundleRow({
      operation: 'merge',
      parentVariantId: 'gid://shopify/ProductVariant/999',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
    });
    const repos = seed({ bundles: [existing] });

    const removedEntry = {
      parentVariantId: existing.parentVariantId,
      price: 29.99,
      sources: ['gid://shopify/ProductVariant/1'],
    };
    // removeMergeConfig's read finds only this bundle's entry -> removing it
    // empties the array -> metafieldsDelete (not metafieldsSet) is called.
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify([removedEntry]) },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          metafieldsDelete: {
            deletedMetafields: [{ key: 'merge_bundles', namespace: '$app:cart-transform', ownerId: 'gid://shopify/Shop/1' }],
            userErrors: [],
          },
        },
      });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'update' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { bundle: { operation: string; metafieldState: string; metafieldGid?: string } };
    expect(json.bundle.operation).toBe('update');
    expect(json.bundle.metafieldState).toBe('Cleared');
    expect(json.bundle.metafieldGid).toBeUndefined();
    // The row no longer claims a metafield it has given up.
    expect(repos.bundles.rows[0]).toMatchObject({
      operation: 'update',
      metafieldState: 'Cleared',
      metafieldGid: null,
    });

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , readQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(readQuery).toContain('merge_bundles');
    const [, , deleteQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(deleteQuery).toContain('metafieldsDelete');
  });

  it('DELETE /api/bundles/:id removes the checkout.merge_bundles entry for a Written merge bundle', async () => {
    const existing = bundleRow({
      operation: 'merge',
      parentVariantId: 'gid://shopify/ProductVariant/999',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
    });
    const repos = seed({ bundles: [existing] });

    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } })
      .mockResolvedValueOnce({ data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } } });

    const res = await app.request(
      '/api/bundles/bundle-1',
      { method: 'DELETE', headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(repos.bundles.rows).toHaveLength(0);

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , readQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(readQuery).toContain('merge_bundles');
    const [, , deleteQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(deleteQuery).toContain('metafieldsDelete');
  });

  // ─── target ("parent") variant verification ───────────────────────
  //
  // The target variant is the one variant a bundle depends on that is NOT a
  // `bundle_item` row, so nothing else on the save path verifies it. Left
  // unchecked, deleting the target product in Shopify kept saving cleanly while
  // the cart transform emitted a `linesMerge`/`composition_v2` pointing at a
  // dead gid.

  it('POST /api/bundles rejects a target variant that no longer exists', async () => {
    const repos = seed();
    // Only the ITEM resolves. The target (999) is absent from `nodes`, which is
    // how Shopify reports a deleted variant.
    mockVariantResolution([variantNode()]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
  headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'merge',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 9.99,
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('ProductVariant/999');
    // Nothing persisted, and no metafield write was attempted.
    expect(repos.bundles.rows).toHaveLength(0);
    expect(repos.bundleItems.rows).toHaveLength(0);
    expect(vi.mocked(adminGraphql)).toHaveBeenCalledTimes(1);
  });

  it('POST /api/bundles resolves the items and the target in ONE Admin call', async () => {
    seed();
    mockVariantResolution([variantNode(), parentNode('gid://shopify/ProductVariant/999')]);
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } } as never)
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/2' }], userErrors: [] } },
      } as never);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
  headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Camp Kit',
          operation: 'merge',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 9.99,
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    // The FIRST Admin call is the resolution, and it carries BOTH ids — the
    // target costs no extra round-trip.
    const [, , , vars] = vi.mocked(adminGraphql).mock.calls[0];
    expect(vars).toEqual({
      ids: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/999'],
    });
  });

  it('PUT /api/bundles/:id rejects a rename when the stored target is deleted', async () => {
    const repos = seed({
        bundles: [bundleRow({
          id: 'bundle-1',
          operation: 'merge',
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 999,
          status: 'Active',
        })],
        bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
      });
    // The target does not resolve.
    mockVariantResolution([]);

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
  headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('ProductVariant/999');
    expect(repos.bundles.rows[0].name).toBe('Camp Kit');
  });

  it('PUT /api/bundles/:id lets a merchant FIX a dead target by choosing a live one', async () => {
    const repos = seed({
        bundles: [bundleRow({
          id: 'bundle-1',
          operation: 'merge',
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 999,
          status: 'Active',
        })],
        bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
      });
    // The NEW target resolves; the dead stored one is never asked about.
    mockVariantResolution([parentNode('gid://shopify/ProductVariant/888')]);
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: null } } } as never)
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/3' }], userErrors: [] } },
      } as never);

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
  headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ parentVariantId: 'gid://shopify/ProductVariant/888' }),
      },
      env('development'),
    );

    // The EFFECTIVE target is verified, not the stored one — otherwise the
    // block would be a trap with no way out.
    expect(res.status).toBe(200);
    expect(repos.bundles.rows[0].parentVariantId).toBe('gid://shopify/ProductVariant/888');
  });

  it('PUT /api/bundles/:id lets a broken bundle be switched off to Draft', async () => {
    const repos = seed({
        bundles: [bundleRow({
          id: 'bundle-1',
          operation: 'merge',
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 999,
          status: 'Active',
        })],
        bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
      });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
  headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Draft' }),
      },
      env('development'),
    );

    // Draft is inactive, so the target is not checked at all — a merchant is
    // never trapped with a live bundle they can neither fix nor disable, and
    // no Admin call is made.
    expect(res.status).toBe(200);
    expect(repos.bundles.rows[0].status).toBe('Draft');
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // The editor's Draft toggle makes this reachable for the first time: a bundle
  // that is genuinely LIVE, switched off by hand. Switching it off has to remove
  // it from checkout, not merely relabel the row — otherwise the merchant sees
  // "Draft" while shoppers keep getting the bundle price.
  it('PUT /api/bundles/:id switching a live bundle to Draft clears it from checkout', async () => {
    const repos = seed({
      bundles: [bundleRow({
        id: 'bundle-1',
        operation: 'expand',
        parentVariantId: 'gid://shopify/ProductVariant/1',
        price: 2999,
        status: 'Active',
        metafieldState: 'Written',
        metafieldGid: 'gid://shopify/Metafield/1',
      })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
    });

    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } },
    } as never);

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Draft' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const { bundle } = (await res.json()) as {
      bundle: { status: string; metafieldState: string; metafieldGid?: string };
    };
    expect(bundle.status).toBe('Draft');
    expect(bundle.metafieldState).toBe('Cleared');
    expect(bundle.metafieldGid).toBeUndefined();
    // The stored row agrees — no dangling gid for a metafield that is gone.
    expect(repos.bundles.rows[0]).toMatchObject({
      status: 'Draft',
      metafieldState: 'Cleared',
      metafieldGid: null,
    });
    // The composition was deleted, and nothing was written. (`metafieldWrites`
    // lives in the scheduling describe, so assert on the calls directly here.)
    const queries = vi.mocked(adminGraphql).mock.calls.map((call) => String(call[2]));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('metafieldsDelete');
    expect(queries.some((q) => q.includes('metafieldsSet'))).toBe(false);
  });

  it('surfaces an unhandled server error as { error } JSON, not an opaque status', async () => {
    // A shop row with no currency makes `shopCurrency` throw a plain Error,
    // outside any route-level catch. Before the global handler that escaped as
    // a body-less platform error, so the client's apiFetch — which reads
    // `error` off the response — had nothing to show and fell back to a bare
    // status code. A merchant saw "failed: 502" with no cause, and so did we.
    seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: null , planName: 'Shopify Plus' })] });

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    // The cause has to survive into the body, not just the server log.
    expect(body.error).toContain('currency');
  });

  // ─── update is gated on the shop's plan ────────────────────────────────────
  //
  // The UI gate is only a disabled menu row, so the API enforces it too:
  // anything posting directly would otherwise store a bundle the store cannot
  // run. The plan is whatever Shopify reported, stored verbatim; only the
  // comparison is ours.

  it('POST /api/bundles refuses an update bundle on a non-Plus plan', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', planName: 'Advanced' })],
    });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Gift wrap',
          operation: 'update',
          parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    // Name the plan, so the limit is not a mystery.
    expect(error).toContain('Advanced');
    expect(repos.bundles.rows).toHaveLength(0);
    // Refused before Shopify is asked anything.
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('POST /api/bundles refuses an update bundle on a development store', async () => {
    // Shopify would ALLOW lineUpdate here — "development stores or Plus" — but
    // this app has no lineUpdate pass, so the bundle would save and then do
    // nothing at checkout. Gating on the plan name keeps dev stores out.
    seed({ shops: [shopRow({ ...SHOP, status: 'installed', planName: 'Developer Preview' })] });

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Gift wrap',
          operation: 'update',
          parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
  });

  it('PUT /api/bundles/:id refuses switching an existing bundle TO update', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', planName: 'Basic' })],
      bundles: [bundleRow({ id: 'bundle-1', operation: 'expand', parentVariantId: 'gid://shopify/ProductVariant/999' })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'update' }),
      },
      env('development'),
    );

    // The EFFECTIVE operation is gated, not just the one on the stored row.
    expect(res.status).toBe(400);
    expect(repos.bundles.rows[0].operation).toBe('expand');
  });

  it('PUT /api/bundles/:id still allows editing a non-update bundle on a non-Plus plan', async () => {
    const repos = seed({
      shops: [shopRow({ ...SHOP, status: 'installed', planName: 'Basic' })],
      // Active, so the target variant IS verified and the queued resolution
      // is consumed. A Draft bundle skips that check, and an unconsumed
      // mockResolvedValueOnce survives vi.clearAllMocks() and leaks onward.
      bundles: [bundleRow({
        id: 'bundle-1',
        operation: 'expand',
        parentVariantId: 'gid://shopify/ProductVariant/999',
        status: 'Active',
        // No target price: bundleRow defaults to 2999, which is above what the
        // parent resolves at (15.00), and the expand price guard would refuse
        // it for a reason that has nothing to do with this test.
        price: null,
      })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
    });
    mockVariantResolution([parentNode('gid://shopify/ProductVariant/999')]);

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      },
      env('development'),
    );

    // The gate must catch `update` only — it is not a general plan paywall.
    expect(res.status).toBe(200);
    expect(repos.bundles.rows[0].name).toBe('Renamed');
  });

  // ─── update target variant ─────────────────────────────────────────────────
  //
  // An `update` bundle writes no metafield, so `parentVariantId` is the ONLY
  // record of which cart line the override applies to. The editor used to omit
  // it on save: the row stored a null parent and the chosen variant appeared to
  // vanish the moment the merchant hit save.

  it('POST /api/bundles persists the target variant of an update bundle', async () => {
    const repos = seed();
    mockVariantResolution([variantNode({ price: '15.00' })]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Gift wrap',
          operation: 'update',
          parentVariantId: 'gid://shopify/ProductVariant/1',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1, priceAdjustment: 12.5 }],
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    // Stored, and echoed back — the editor reads this to re-render the chip.
    expect(repos.bundles.rows[0].parentVariantId).toBe('gid://shopify/ProductVariant/1');
    const { bundle } = (await res.json()) as { bundle: { parentVariantId?: string } };
    expect(bundle.parentVariantId).toBe('gid://shopify/ProductVariant/1');
  });

  it('POST /api/bundles rejects an update bundle with no target variant', async () => {
    const repos = seed();
    // No resolution mock queued on purpose: the guard runs before Shopify is
    // asked anything, and an unconsumed mockResolvedValueOnce survives
    // vi.clearAllMocks() and leaks into the next test.

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Gift wrap',
          operation: 'update',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
        }),
      },
      env('development'),
    );

    // Without a target the row is meaningless and nothing can render it.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/target variant/i);
    expect(repos.bundles.rows).toHaveLength(0);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // ─── expand price ──────────────────────────────────────────────────────────
  //
  // Shopify bases a lineExpand adjustment on the BUNDLE PRODUCT price, not the
  // components' sum the way linesMerge does. The price is optional: blank
  // leaves the line at whatever the bundle product costs.

  it('POST /api/bundles writes the expand target price into the composition metafield', async () => {
    seed();
    mockVariantResolution([
      variantNode({ price: '20.00' }),
      parentNode('gid://shopify/ProductVariant/999'),
    ]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/7' }], userErrors: [] } },
    } as never);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Kit',
          operation: 'expand',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
          // The parent (parentNode) resolves at 15.00; 9.99 is below it.
          price: 9.99,
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    const [, , , writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    const value = JSON.parse(
      (writeVars as { metafields: { value: string }[] }).metafields[0].value,
    ) as { price: number; components: unknown[] };
    // The object shape, not the bare array — that is what carries the target.
    expect(value.price).toBe(9.99);
    expect(value.components).toHaveLength(1);
  });

  it('POST /api/bundles keeps the bare component array when expand has no price', async () => {
    seed();
    mockVariantResolution([
      variantNode({ price: '20.00' }),
      parentNode('gid://shopify/ProductVariant/999'),
    ]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/8' }], userErrors: [] } },
    } as never);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Kit',
          operation: 'expand',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(201);
    const [, , , writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    const value = JSON.parse(
      (writeVars as { metafields: { value: string }[] }).metafields[0].value,
    );
    // The shape the Rust function has always read, so a priceless bundle keeps
    // working exactly as before.
    expect(Array.isArray(value)).toBe(true);
  });

  it('POST /api/bundles rejects an expand price at or above the bundle product price', async () => {
    const repos = seed();
    mockVariantResolution([
      variantNode({ price: '20.00' }),
      // The parent product itself costs 15.00.
      parentNode('gid://shopify/ProductVariant/999'),
    ]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Kit',
          operation: 'expand',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 15,
        }),
      },
      env('development'),
    );

    // percentageDecrease cannot raise a price, so this would silently do
    // nothing at checkout. The base is the PRODUCT price (15.00), not the
    // components (20.00) — an expand priced at 18 would also be rejected even
    // though it is below the components.
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('15.00');
    expect(repos.bundles.rows).toHaveLength(0);
  });

  // ─── merge price sanity ────────────────────────────────────────────────────
  //
  // `linesMerge` can only REDUCE a price: the Rust cart transform turns the
  // target into a percentage off the live subtotal and clamps it to 0..=100.
  // A target at or above what the components cost asks for a negative discount,
  // clamps to zero, and renders the merged line at full price with no error
  // anywhere. Checkout looks like nothing happened, so the save is the only
  // place a merchant can be told.

  it('POST /api/bundles rejects a merge price at or above the components', async () => {
    const repos = seed();
    mockVariantResolution([variantNode({ price: '32.00' }), parentNode('gid://shopify/ProductVariant/999')]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'New bundle',
          operation: 'merge',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 3 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
          // Components come to 96.00; asking 1600.00 can never discount.
          price: 1600,
        }),
      },
      env('development'),
    );

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    // The message has to carry both numbers — "invalid price" would leave the
    // merchant guessing which way to move it.
    expect(error).toContain('96.00');
    expect(error).toContain('1600.00');
    expect(repos.bundles.rows).toHaveLength(0);
  });

  it('POST /api/bundles rejects a merge price exactly equal to the components', async () => {
    seed();
    mockVariantResolution([variantNode({ price: '32.00' }), parentNode('gid://shopify/ProductVariant/999')]);

    const res = await app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'New bundle',
          operation: 'merge',
          items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 32,
        }),
      },
      env('development'),
    );

    // A 0% discount is still a bundle that does nothing.
    expect(res.status).toBe(400);
  });

  it('PUT /api/bundles/:id rejects a price-only edit that lifts it above the components', async () => {
    const repos = seed({
      bundles: [bundleRow({
        id: 'bundle-1',
        operation: 'merge',
        parentVariantId: 'gid://shopify/ProductVariant/999',
        price: 999,
        status: 'Active',
      })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1', price: 3200, qty: 1 })],
    });
    // The target still resolves — only the price is wrong.
    mockVariantResolution([parentNode('gid://shopify/ProductVariant/999')]);

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ price: 50 }),
      },
      env('development'),
    );

    // A price-only PUT sends no items, which is exactly the edit most likely
    // to push the price past the components — so the guard cannot live inside
    // the items branch.
    expect(res.status).toBe(400);
    expect(repos.bundles.rows[0].price).toBe(999);
  });

  it('DELETE /api/bundles/:id still works when the target is deleted', async () => {
    const repos = seed({
        bundles: [bundleRow({
          id: 'bundle-1',
          operation: 'merge',
          parentVariantId: 'gid://shopify/ProductVariant/999',
          price: 999,
          status: 'Active',
        })],
        bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
      });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'DELETE',
  headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      },
      env('development'),
    );

    // Removing a broken bundle must never be blocked.
    expect(res.status).toBe(200);
    expect(repos.bundles.rows).toHaveLength(0);
  });
});

describe('GET /api/variants (batch variant name + admin URL resolution)', () => {
  beforeEach(() => vi.clearAllMocks());

  const V1 = 'gid://shopify/ProductVariant/111';
  const V2 = 'gid://shopify/ProductVariant/222';

  /** The route reads the shop domain off the context — no db call of its own. */
  const mockShopChain = () => {
    seed();
  };

  const request = (qs: string) =>
    app.request(
      `/api/variants${qs}`,
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

  it('resolves product + variant titles and a variant-level admin URL in one Admin call', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        nodes: [
          {
            id: V1,
            title: 'Large / Blue',
            image: { url: 'https://cdn.shopify.com/hoodie-blue.jpg', altText: 'Blue hoodie' },
            product: {
              id: 'gid://shopify/Product/456',
              title: 'Merino Hoodie',
              featuredImage: { url: 'https://cdn.shopify.com/hoodie.jpg', altText: 'Hoodie' },
            },
          },
          {
            id: V2,
            title: 'Default Title',
            image: null,
            product: {
              id: 'gid://shopify/Product/789',
              title: 'Wool Socks',
              featuredImage: { url: 'https://cdn.shopify.com/socks.jpg', altText: 'Socks' },
            },
          },
        ],
      },
    });

    const res = await request(`?ids=${encodeURIComponent(`${V1},${V2}`)}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      variants: [
        {
          id: V1,
          exists: true,
          productId: 'gid://shopify/Product/456',
          productTitle: 'Merino Hoodie',
          variantTitle: 'Large / Blue',
          adminUrl: 'https://mystore.myshopify.com/admin/products/456/variants/111',
          // The variant's own image wins over the product's featured image.
          imageUrl: 'https://cdn.shopify.com/hoodie-blue.jpg',
          imageAlt: 'Blue hoodie',
        },
        {
          id: V2,
          exists: true,
          productId: 'gid://shopify/Product/789',
          productTitle: 'Wool Socks',
          variantTitle: 'Default Title',
          adminUrl: 'https://mystore.myshopify.com/admin/products/789/variants/222',
          // No variant image -> falls back to the product's featured image.
          imageUrl: 'https://cdn.shopify.com/socks.jpg',
          imageAlt: 'Socks',
        },
      ],
    });
    expect(adminGraphql).toHaveBeenCalledTimes(1);
    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[0];
    expect(query).toContain('nodes');
    expect(query).toContain('featuredImage');
    expect(variables).toEqual({ ids: [V1, V2] });
  });

  it('flags a deleted variant as exists:false instead of dropping it', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        nodes: [
          null,
          { id: V2, title: 'Default Title', product: { id: 'gid://shopify/Product/789', title: 'Wool Socks' } },
        ],
      },
    });

    const res = await request(`?ids=${encodeURIComponent(`${V1},${V2}`)}`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { variants: Array<Record<string, unknown>> };
    expect(json.variants).toHaveLength(2);
    expect(json.variants[0]).toEqual({ id: V1, exists: false });
    expect(json.variants[1]).toMatchObject({ id: V2, exists: true });
  });

  it('returns 400 when ids is missing or empty, without calling the Admin API', async () => {
    seed();
    const res = await request('');

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toEqual(expect.any(String));
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-ProductVariant gid', async () => {
    seed();
    const res = await request(`?ids=${encodeURIComponent('gid://shopify/Product/456')}`);

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns 400 when more than 50 ids are requested', async () => {
    seed();
    const ids = Array.from({ length: 51 }, (_, i) => `gid://shopify/ProductVariant/${i}`).join(',');
    const res = await request(`?ids=${encodeURIComponent(ids)}`);

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('de-duplicates repeated ids before calling the Admin API', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        nodes: [{ id: V1, title: 'Large / Blue', product: { id: 'gid://shopify/Product/456', title: 'Merino Hoodie' } }],
      },
    });

    const res = await request(`?ids=${encodeURIComponent(`${V1},${V1}`)}`);

    expect(res.status).toBe(200);
    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[0];
    expect(variables).toEqual({ ids: [V1] });
  });

  it('returns 502 when the Admin API reports GraphQL errors', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: null,
      errors: [{ message: 'Throttled' }],
    } as unknown as Awaited<ReturnType<typeof adminGraphql>>);

    const res = await request(`?ids=${encodeURIComponent(V1)}`);

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Throttled');
  });

  it('returns 502 when the Admin call throws', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockRejectedValueOnce(new Error('network down'));

    const res = await request(`?ids=${encodeURIComponent(V1)}`);

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('network down');
  });

  it('is protected by requireShop', async () => {
    seed({ shops: [] });
    const res = await app.request(`/api/variants?ids=${encodeURIComponent(V1)}`, {}, env('development'));
    expect(res.status).toBe(401);
  });

  it('omits image fields entirely when neither the variant nor its product has one', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        nodes: [
          {
            id: V1,
            title: 'Large / Blue',
            image: null,
            product: { id: 'gid://shopify/Product/456', title: 'Merino Hoodie', featuredImage: null },
          },
        ],
      },
    });

    const res = await request(`?ids=${encodeURIComponent(V1)}`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { variants: Array<Record<string, unknown>> };
    expect(json.variants[0]).toEqual({
      id: V1,
      exists: true,
      productId: 'gid://shopify/Product/456',
      productTitle: 'Merino Hoodie',
      variantTitle: 'Large / Blue',
      adminUrl: 'https://mystore.myshopify.com/admin/products/456/variants/111',
    });
  });

  it('keeps a missing altText out of the response rather than emitting null', async () => {
    mockShopChain();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: {
        nodes: [
          {
            id: V1,
            title: 'Large / Blue',
            image: { url: 'https://cdn.shopify.com/hoodie-blue.jpg', altText: null },
            product: { id: 'gid://shopify/Product/456', title: 'Merino Hoodie', featuredImage: null },
          },
        ],
      },
    });

    const res = await request(`?ids=${encodeURIComponent(V1)}`);

    const json = (await res.json()) as { variants: Array<Record<string, unknown>> };
    expect(json.variants[0]).toMatchObject({ imageUrl: 'https://cdn.shopify.com/hoodie-blue.jpg' });
    expect(json.variants[0]).not.toHaveProperty('imageAlt');
  });
});

/**
 * The schedule window, end to end through the real route.
 *
 * Shopify is mocked at the transport (`adminGraphql`), so `writeComposition`
 * and `upsertMergeConfig` run for real — "no metafield was written" is asserted
 * by confirming no `metafieldsSet` mutation ever reached the transport. The
 * variant-resolution read still happens on every save (a create always verifies
 * its target variant, whatever its status), so it is mocked in every test here
 * and deliberately NOT what these assertions look at.
 */
describe('bundle scheduling', () => {
  beforeEach(() => vi.clearAllMocks());

  const PARENT = 'gid://shopify/ProductVariant/1';
  const ITEM = 'gid://shopify/ProductVariant/2';

  /** Did any Admin call carry the metafield-write mutation? */
  const metafieldWrites = () =>
    vi.mocked(adminGraphql).mock.calls.filter(([, , query]) => String(query).includes('metafieldsSet'));

  /** Queues the variant-resolution read every save makes first. */
  const mockSaveReads = () =>
    mockVariantResolution([variantNode({ id: ITEM, price: '15.00' }), parentNode(PARENT)]);

  const createBundle = (extra: Record<string, unknown>) =>
    app.request(
      '/api/bundles',
      {
        method: 'POST',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'expand',
          parentVariantId: PARENT,
          items: [{ variantId: ITEM, qty: 1 }],
          ...extra,
        }),
      },
      env('development'),
    );

  it('stores a future window as Scheduled and writes NO metafield', async () => {
    seed();
    mockSaveReads();

    const res = await createBundle({ name: 'Holiday bundle', scheduleStart: '2099-01-01T00:00:00.000Z' });

    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as { bundle: { status: string; metafieldState: string } };
    expect(bundle.status).toBe('Scheduled');
    expect(bundle.metafieldState).toBe('NotYet');
    expect(metafieldWrites()).toHaveLength(0);
  });

  it('stores an already-open window as Active and writes the metafield now', async () => {
    seed();
    mockSaveReads();
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } },
    });

    const res = await createBundle({
      name: 'Live bundle',
      scheduleStart: '2020-01-01T00:00:00.000Z',
      scheduleEnd: '2099-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as { bundle: { status: string; metafieldState: string } };
    expect(bundle.status).toBe('Active');
    expect(bundle.metafieldState).toBe('Written');
    expect(metafieldWrites()).toHaveLength(1);
  });

  it('stores a window entirely in the past as Ended and writes nothing', async () => {
    seed();
    mockSaveReads();

    const res = await createBundle({
      name: 'Old bundle',
      scheduleStart: '2020-01-01T00:00:00.000Z',
      scheduleEnd: '2020-02-01T00:00:00.000Z',
    });

    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as { bundle: { status: string } };
    expect(bundle.status).toBe('Ended');
    expect(metafieldWrites()).toHaveLength(0);
  });

  // Review Focus #3 — stored verbatim, a non-Z offset makes the index lie.
  it('normalizes a non-Z offset to Z form before storing', async () => {
    const repos = seed();
    mockSaveReads();

    const res = await createBundle({ name: 'Offset bundle', scheduleStart: '2099-10-03T19:00:00+10:00' });

    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as { bundle: { scheduleStart: string | null } };
    expect(bundle.scheduleStart).toBe('2099-10-03T09:00:00.000Z');
    // ...and the stored row, which is what the due-scan index orders on.
    expect(repos.bundles.rows[0].scheduleStart).toBe('2099-10-03T09:00:00.000Z');
  });

  it('rejects an unparseable datetime with 400 rather than storing null', async () => {
    const repos = seed();
    mockSaveReads();

    const res = await createBundle({ name: 'Bad bundle', scheduleStart: 'next tuesday' });

    expect(res.status).toBe(400);
    // A null bound means "permanently live" — a parse failure must not become one.
    expect(repos.bundles.rows).toHaveLength(0);
    expect(metafieldWrites()).toHaveLength(0);
  });

  it('rejects a start at or after its end with 400', async () => {
    const repos = seed();
    mockSaveReads();

    const res = await createBundle({
      name: 'Backwards bundle',
      scheduleStart: '2099-02-01T00:00:00.000Z',
      scheduleEnd: '2099-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(400);
    expect(repos.bundles.rows).toHaveLength(0);
  });

  it('ignores a client trying to pin a future-windowed bundle Active', async () => {
    seed();
    mockSaveReads();

    const res = await createBundle({
      name: 'Pinned bundle',
      scheduleStart: '2099-01-01T00:00:00.000Z',
      status: 'Active',
    });

    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as { bundle: { status: string } };
    expect(bundle.status).toBe('Scheduled');
    expect(metafieldWrites()).toHaveLength(0);
  });

  it('PUT: pulling the start date into the past goes live now, without waiting for the cron', async () => {
    const repos = seed({
      bundles: [bundleRow({
        id: 'bundle-1',
        operation: 'expand',
        parentVariantId: PARENT,
        price: 999, // $9.99, below the $15.00 target price
        status: 'Scheduled',
        scheduleStart: '2099-01-01T00:00:00.000Z',
        metafieldState: 'NotYet',
      })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
    });
    // Now live, so the target is verified; then the composition is written.
    mockVariantResolution([parentNode(PARENT)]);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/9' }], userErrors: [] } },
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleStart: '2020-01-01T00:00:00.000Z' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const { bundle } = (await res.json()) as { bundle: { status: string; metafieldState: string } };
    expect(bundle.status).toBe('Active');
    expect(bundle.metafieldState).toBe('Written');
    expect(metafieldWrites()).toHaveLength(1);
    expect(repos.bundles.rows[0]).toMatchObject({
      status: 'Active',
      scheduleStart: '2020-01-01T00:00:00.000Z',
      metafieldState: 'Written',
    });
  });

  it('PUT: an end date in the past ends the bundle and clears its transport', async () => {
    const repos = seed({
      bundles: [bundleRow({
        id: 'bundle-1',
        operation: 'expand',
        parentVariantId: PARENT,
        price: 999,
        status: 'Active',
        metafieldState: 'Written',
        metafieldGid: 'gid://shopify/Metafield/1',
      })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
    });
    // Ended is inactive, so the target is not re-verified — the only Admin
    // call is the clear.
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } },
    });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleEnd: '2020-02-01T00:00:00.000Z' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const { bundle } = (await res.json()) as { bundle: { status: string; metafieldState: string } };
    expect(bundle.status).toBe('Ended');
    expect(bundle.metafieldState).toBe('Cleared');
    expect(metafieldWrites()).toHaveLength(0);
    expect(adminGraphql).toHaveBeenCalledTimes(1);
    const [, , query] = vi.mocked(adminGraphql).mock.calls[0];
    expect(query).toContain('metafieldsDelete');
    expect(repos.bundles.rows[0]).toMatchObject({ status: 'Ended', metafieldState: 'Cleared', metafieldGid: null });
  });

  it('PUT: a parent change that also ends the bundle leaves no row claiming a metafield', async () => {
    // Phase 1 removes the OLD parent's entry, and Phase 2 is gated off because
    // the bundle is no longer live — so nothing rewrites `metafieldState`.
    // The row must not be left claiming `Written` with a dead gid: the due-scan
    // only revisits `Scheduled`/`Active` rows, so nothing would ever fix it.
    const OLD_PARENT = 'gid://shopify/ProductVariant/999';
    const NEW_PARENT = 'gid://shopify/ProductVariant/111';
    const repos = seed({
      bundles: [bundleRow({
        id: 'bundle-1',
        operation: 'merge',
        parentVariantId: OLD_PARENT,
        price: 2999,
        status: 'Active',
        metafieldState: 'Written',
        metafieldGid: 'gid://shopify/Metafield/1',
      })],
      bundleItems: [bundleItemRow({ bundleId: 'bundle-1' })],
    });
    // removeMergeConfig's read + delete for the OLD parent, and nothing else.
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            metafield: {
              id: 'gid://shopify/Metafield/1',
              value: JSON.stringify([
                { parentVariantId: OLD_PARENT, price: 29.99, sources: ['gid://shopify/ProductVariant/1'] },
              ]),
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } },
      });

    const res = await app.request(
      '/api/bundles/bundle-1',
      {
        method: 'PUT',
        headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
        body: JSON.stringify({ parentVariantId: NEW_PARENT, scheduleEnd: '2020-02-01T00:00:00.000Z' }),
      },
      env('development'),
    );

    expect(res.status).toBe(200);
    const { bundle } = (await res.json()) as {
      bundle: { status: string; metafieldState: string; metafieldGid?: string };
    };
    expect(bundle.status).toBe('Ended');
    expect(bundle.metafieldState).toBe('Cleared');
    expect(bundle.metafieldGid).toBeUndefined();
    // The stored row agrees — no dangling gid for an entry that is gone.
    expect(repos.bundles.rows[0]).toMatchObject({
      status: 'Ended',
      metafieldState: 'Cleared',
      metafieldGid: null,
    });
    // Only the old entry's removal happened; nothing was written.
    expect(metafieldWrites()).toHaveLength(0);
    expect(adminGraphql).toHaveBeenCalledTimes(2);
  });

  it('honours Draft as the manual off-switch whatever the window says', async () => {
    seed();
    mockSaveReads();

    const res = await createBundle({
      name: 'Off bundle',
      scheduleStart: '2020-01-01T00:00:00.000Z',
      status: 'Draft',
    });

    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as { bundle: { status: string } };
    expect(bundle.status).toBe('Draft');
    expect(metafieldWrites()).toHaveLength(0);
  });
});

describe('Template API (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());

  const templateRow = (over: Partial<TemplateRow> = {}): TemplateRow => ({
    id: 'tpl-1',
    slug: 'pct-off',
    name: 'Percentage off',
    description: 'Take a percentage off.',
    example: '15% off',
    category: 'Save %',
    symbol: '%',
    type: 'tier',
    defaults: JSON.stringify({ platform: 'BOTH', tiers: [] }),
    sortOrder: 10,
    active: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('GET /api/templates returns active templates with defaults parsed', async () => {
    seed({ templates: [templateRow()] });

    const res = await app.request(
      '/api/templates',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { templates: Array<{ slug: string; defaults: unknown }> };
    expect(json.templates).toHaveLength(1);
    expect(json.templates[0].slug).toBe('pct-off');
    // Parsed, not a string — the client should not re-parse what we validated.
    expect(json.templates[0].defaults).toEqual({ platform: 'BOTH', tiers: [] });
  });

  it('GET /api/templates omits retired templates', async () => {
    seed({ templates: [templateRow({ slug: 'old', active: 0 })] });

    const res = await app.request(
      '/api/templates',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    const json = (await res.json()) as { templates: unknown[] };
    expect(json.templates).toEqual([]);
  });

  it('GET /api/templates/:slug returns one', async () => {
    seed({ templates: [templateRow()] });

    const res = await app.request(
      '/api/templates/pct-off',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { template: { slug: string; type: string } };
    expect(json.template).toMatchObject({ slug: 'pct-off', type: 'tier' });
  });

  // Review Focus #3
  it('GET /api/templates/:slug 404s a retired template', async () => {
    seed({ templates: [templateRow({ active: 0 })] });

    const res = await app.request(
      '/api/templates/pct-off',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });

  it('GET /api/templates/:slug 404s an unknown slug', async () => {
    seed({ templates: [] });

    const res = await app.request(
      '/api/templates/nope',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });
});

describe('POST /api/discounts', () => {
  beforeEach(() => vi.clearAllMocks());

  const TIER_FORM = {
    message: 'Buy more save more',
    applyTo: 'price',
    discountType: 'percentage',
    productDiscountSelectionStrategy: 'MAXIMUM',
    platform: 'BOTH',
    tiers: [{
      id: 't1', value: '20', selectorType: 'variant_id',
      targets: JSON.stringify([{ variantId: '123' }]), min_qty: '3',
    }],
  };

  const templateRow = (over: Partial<TemplateRow> = {}): TemplateRow => ({
    id: 'tpl-1',
    slug: 'pct-off',
    name: 'Percentage off',
    description: 'd',
    example: null,
    category: 'Save %',
    symbol: '%',
    type: 'tier',
    defaults: JSON.stringify({ platform: 'BOTH', tiers: [] }),
    sortOrder: 10,
    active: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const post = (body: unknown) => app.request(
    '/api/discounts',
    {
      method: 'POST',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env('development'),
  );

  function mockFunctionsThenCreate() {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountAutomaticAppCreate: {
          automaticAppDiscount: { discountId: 'gid://shopify/DiscountAutomaticNode/1' },
          userErrors: [],
        } },
      } as never);
  }

  it('creates the discount and its config in one mutation', async () => {
    seed({ templates: [templateRow()] });
    mockFunctionsThenCreate();

    const res = await post({ slug: 'pct-off', title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(200);
    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.functionId).toBe('gid://shopify/Function/tier');
    const metafields = input.metafields as Array<{ namespace: string; key: string; value: string }>;
    expect(metafields[0].namespace).toBe('$app:discount-tier');
    expect(metafields[0].key).toBe('config');
    expect(JSON.parse(metafields[0].value).rule_type).toBe('tier-discount');
  });

  // Shopify refuses the mutation without this: "Functions configured to use the
  // `discounts` API type require the discountClasses field to be set." It was
  // missing, so every create 502'd after passing every local check.
  it('sends the discount classes the function emits', async () => {
    seed({ templates: [templateRow()] });
    mockFunctionsThenCreate();

    await post({ slug: 'pct-off', title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.discountClasses).toEqual(['PRODUCT']);
  });

  it('creates a CODE discount when the merchant asks for one', async () => {
    seed({ templates: [templateRow()] });
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountCodeAppCreate: {
          codeAppDiscount: { discountId: 'gid://shopify/DiscountCodeNode/9' },
          userErrors: [],
        } },
      } as never);

    const res = await post({
      slug: 'pct-off', title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z',
      method: 'code', code: 'SPRING20', form: TIER_FORM,
    });

    expect(res.status).toBe(200);
    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[1];
    expect(String(query)).toContain('discountCodeAppCreate');
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.code).toBe('SPRING20');
    // The 2026-04 docs say DiscountCodeAppInput does not take discountClasses.
    // A real store says otherwise — omitting it 502s with "Functions configured
    // to use the `discounts` API type require the discountClasses field".
    expect(input.discountClasses).toEqual(['PRODUCT']);
    // Same engine, same config — only the trigger differs.
    const metafields = input.metafields as Array<{ namespace: string; value: string }>;
    expect(metafields[0].namespace).toBe('$app:discount-tier');
    expect(JSON.parse(metafields[0].value).rule_type).toBe('tier-discount');
  });

  // Shopify's own admin titles a code discount with its code; two different
  // strings would show the merchant one name in our list and another in theirs.
  it('titles a code discount with its code, whatever title was sent', async () => {
    seed({ templates: [templateRow()] });
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountCodeAppCreate: { codeAppDiscount: { discountId: 'gid://shopify/DiscountCodeNode/9' }, userErrors: [] } },
      } as never);

    await post({
      slug: 'pct-off', title: 'Something else entirely', startsAt: '2026-10-01T00:00:00.000Z',
      method: 'code', code: 'SPRING20', form: TIER_FORM,
    });

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.title).toBe('SPRING20');
    expect(input.code).toBe('SPRING20');
  });

  it('accepts a code discount with no title at all', async () => {
    seed({ templates: [templateRow()] });
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountCodeAppCreate: { codeAppDiscount: { discountId: 'gid://shopify/DiscountCodeNode/9' }, userErrors: [] } },
      } as never);

    const res = await post({
      slug: 'pct-off', startsAt: '2026-10-01T00:00:00.000Z',
      method: 'code', code: 'SPRING20', form: TIER_FORM,
    });

    expect(res.status).toBe(200);
  });

  it('still requires a title for an automatic discount', async () => {
    seed({ templates: [templateRow()] });

    const res = await post({ slug: 'pct-off', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('400s a code discount with no code, without calling Shopify', async () => {
    seed({ templates: [templateRow()] });

    const res = await post({
      slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
      method: 'code', form: TIER_FORM,
    });

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('still defaults to an automatic discount when no method is given', async () => {
    seed({ templates: [templateRow()] });
    mockFunctionsThenCreate();

    await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    const [, , query] = vi.mocked(adminGraphql).mock.calls[1];
    expect(String(query)).toContain('discountAutomaticAppCreate');
  });

  it('404s an unknown slug without calling Shopify', async () => {
    seed({ templates: [] });

    const res = await post({ slug: 'nope', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(404);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('400s an invalid form without calling Shopify', async () => {
    seed({ templates: [templateRow()] });

    const res = await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: { ...TIER_FORM, tiers: [] } });

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('400s a missing form without calling Shopify', async () => {
    seed({ templates: [templateRow()] });

    const res = await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('form is required');
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review Focus #5
  it('400s a config over 10KB before calling Shopify', async () => {
    seed({ templates: [templateRow()] });
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `t${i}`, value: String(i + 1), selectorType: 'variant_id',
      targets: JSON.stringify(Array.from({ length: 20 }, (_, j) => ({ variantId: String(j), productTitle: 'A long product title here' }))),
      min_qty: '1',
    }));

    const res = await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: { ...TIER_FORM, tiers: many } });

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/10 ?KB|too large/i);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review fix — the form validates, but buildTierConfig resolves no ids for a
  // `product_id` tier whose items only carry `variantId`. Without the
  // actionability guard this creates a live discount that does nothing.
  it('400s a form that validates but builds no usable rules, without calling Shopify', async () => {
    seed({ templates: [templateRow()] });

    const res = await post({
      slug: 'pct-off',
      title: 'Spring sale',
      startsAt: '2026-10-01T00:00:00.000Z',
      form: {
        ...TIER_FORM,
        tiers: [{
          id: 't1', value: '20', selectorType: 'product_id',
          targets: JSON.stringify([{ variantId: '123' }]), min_qty: '',
        }],
      },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('no usable rules');
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review Focus #2 — the template decides the engine; the client does not.
  it('ignores a client-supplied type and uses the template’s engine', async () => {
    seed({ templates: [templateRow()] });
    mockFunctionsThenCreate();

    await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', type: 'special', form: TIER_FORM });

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const metafields = (variables as { discount: { metafields: Array<{ namespace: string }> } }).discount.metafields;
    expect(metafields[0].namespace).toBe('$app:discount-tier');
  });

  it('502s on Shopify userErrors rather than reporting success', async () => {
    seed({ templates: [templateRow()] });
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountAutomaticAppCreate: { automaticAppDiscount: null, userErrors: [{ field: ['title'], message: 'Title is invalid' }] } },
      } as never);

    const res = await post({ slug: 'pct-off', title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Title is invalid');
  });
});
