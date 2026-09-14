import { describe, it, expect, vi, beforeEach } from 'vitest';

// Run the real Hono app in-process with the data + Shopify layers mocked, so
// the protected-route flow is exercised end-to-end with no real bindings or
// credentials (mirrors the mocking style of the other unit tests).
vi.mock('./db/db', () => ({
  setDb: vi.fn(),
  createDb: vi.fn(),
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
import { createDb } from './db/db';
import { adminGraphql } from './lib/graphqlAdmin';
import { ensureCartTransform } from './lib/cartTransformRegistration';
import { removeCartTransformMetafieldDefinitions, getMetafieldSetupStatus } from './lib/metafieldDefinitions';

// Minimal chainable Drizzle stand-in: `.select().from().where().get()` resolves
// to the given row (or null), and `.where().all()` resolves to an array (or
// `[row]` when a single non-null row was given). Also stubs `.insert().values()`,
// `.update().set().where()`, and `.delete().where()` so callers can assert they
// were invoked. Typed as the createDb return so call sites need no cast.
function mockDb(
  row: Record<string, unknown> | Record<string, unknown>[] | null,
): ReturnType<typeof createDb> & { insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  const rows = Array.isArray(row) ? row : row ? [row] : [];
  const single = Array.isArray(row) ? (row[0] ?? null) : row;

  const insertFn = vi.fn(() => ({
    values: vi.fn(() => Promise.resolve(undefined)),
  }));
  const updateFn = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(undefined)),
    })),
  }));
  const deleteFn = vi.fn(() => ({
    where: vi.fn(() => Promise.resolve(undefined)),
  }));

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => Promise.resolve(single),
          all: () => Promise.resolve(rows),
        }),
      }),
    }),
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as ReturnType<typeof createDb> & { insert: typeof insertFn; update: typeof updateFn; delete: typeof deleteFn };
}

// The DB/KV/R2 bindings are mocked above and never read on this path, so we
// pass only the variable the auth fallback actually checks.
const env = (environment: 'development' | 'production') => ({ ENVIRONMENT: environment });

describe('GET /api/example (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(createDb).mockReturnValue(mockDb(null));
    const res = await app.request('/api/example', {}, env('development'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the shop profile for an installed shop via the dev header fallback', async () => {
    vi.mocked(createDb).mockReturnValue(
      mockDb({
        id: 'shop-abc',
        name: 'Test Store',
        owner: 'Jane Merchant',
        status: 'installed',
      }),
    );
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
    vi.mocked(createDb).mockReturnValue(mockDb({ id: 'shop-abc' }));
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
    const row = {
      id: 'disc-1', shopId: 'shop-abc', shopifyGid: 'gid://shopify/DiscountNode/1',
      name: 'Summer Volume', type: 'tier', method: 'automatic', status: 'active',
      products: 3, campaignId: null, deletedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    };
    // requireShop -> getCurrentShopId reads the shop row first, then the route reads the discount row.
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(row));
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
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(null));
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
    const shopDb = mockDb({ id: 'shop-abc' });
    // requireShop's getCurrentShopId reads the shop row first (shopDb), then
    // the route reads the shop row again (for the domain + cached columns),
    // and finally updates the row to cache the plan (routeDb serves both).
    const routeDb = mockDb({ id: 'shop-abc', myshopifyDomain: 'mystore.myshopify.com', shopifyPlus: null, partnerDevelopment: null, planName: null });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { shop: { plan: { shopifyPlus: true, partnerDevelopment: false, displayName: 'Shopify Plus' } } },
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updateOpEligible: true, planName: 'Shopify Plus' });
    expect(adminGraphql).toHaveBeenCalledTimes(1);
    expect(routeDb.update).toHaveBeenCalled();
  });

  it('queries adminGraphql and returns updateOpEligible=false for a Basic non-dev store', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ id: 'shop-abc', myshopifyDomain: 'mystore.myshopify.com', shopifyPlus: null, partnerDevelopment: null, planName: null });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { shop: { plan: { shopifyPlus: false, partnerDevelopment: false, displayName: 'Basic' } } },
    });

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updateOpEligible: false, planName: 'Basic' });
    expect(adminGraphql).toHaveBeenCalledTimes(1);
  });

  it('returns cached plan without calling adminGraphql when already cached', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ id: 'shop-abc', myshopifyDomain: 'mystore.myshopify.com', shopifyPlus: 1, partnerDevelopment: 0, planName: 'Shopify Plus' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);

    const res = await app.request(
      '/api/shop/plan',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updateOpEligible: true, planName: 'Shopify Plus' });
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns 404 when the shop row/domain is missing', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb(null);
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);

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

  const bundleRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'bundle-1',
    shopId: 'shop-abc',
    name: 'Camp Kit',
    operation: 'merge',
    items: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }]),
    parentVariantId: null,
    price: 2999, // cents => $29.99
    sumOfItems: 3999, // cents => $39.99
    metafieldState: 'NotYet',
    metafieldGid: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: 'Draft',
    blockOnFailure: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  });

  it('GET /api/bundles returns bundles + summary with correct avgSaving math', async () => {
    const rows = [
      bundleRow({ id: 'bundle-1', price: 2999, sumOfItems: 3999 }), // saving $10.00
      bundleRow({ id: 'bundle-2', price: 1000, sumOfItems: 1500 }), // saving $5.00
    ];
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(rows));

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bundles: { id: string; price: number; sumOfItems: number }[];
      summary: { count: number; inCampaigns: number; avgSaving: number };
    };
    expect(json.bundles).toHaveLength(2);
    expect(json.bundles[0].price).toBe(29.99);
    expect(json.bundles[0].sumOfItems).toBe(39.99);
    expect(json.summary).toEqual({ count: 2, inCampaigns: 0, avgSaving: 8 }); // mean(10, 5) = 7.5 -> round = 8
  });

  it('GET /api/bundles returns zeroed summary when empty', async () => {
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb([]));

    const res = await app.request(
      '/api/bundles',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bundles: unknown[]; summary: { count: number; inCampaigns: number; avgSaving: number } };
    expect(json.bundles).toEqual([]);
    expect(json.summary).toEqual({ count: 0, inCampaigns: 0, avgSaving: 0 });
  });

  it('GET /api/bundles/:id returns 404 for missing/other-shop bundle', async () => {
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(null));

    const res = await app.request(
      '/api/bundles/ghost',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/bundles inserts and returns 201 with cents<->dollars round-trip', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const insertDb = mockDb(null);
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(insertDb);

    // `operation: 'update'` — this test is only about the cents<->dollars
    // round-trip, not merge-specific validation, so it deliberately avoids
    // the merge guards (which require a price + parentVariantId) and any
    // metafield write.
    const body = {
      name: 'Camp Kit',
      operation: 'update',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
      price: 29.99,
      sumOfItems: 39.99,
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
      bundle: { id: string; name: string; price: number; sumOfItems: number; status: string; metafieldState: string; items: unknown[] };
    };
    expect(json.bundle.id).toBeTruthy();
    expect(json.bundle.name).toBe('Camp Kit');
    expect(json.bundle.price).toBe(29.99);
    expect(json.bundle.sumOfItems).toBe(39.99);
    expect(json.bundle.status).toBe('Draft');
    expect(json.bundle.metafieldState).toBe('NotYet');
    expect(json.bundle.items).toEqual(body.items);
    expect(insertDb.insert).toHaveBeenCalled();
  });

  it('POST /api/bundles returns 400 with a JSON error when name is missing', async () => {
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));

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
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));

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

  it('PUT /api/bundles/:id updates and returns 200 with cents<->dollars round-trip', async () => {
    // `operation: 'update'` — this test is only about the cents<->dollars
    // round-trip, not merge-specific validation, so it deliberately avoids
    // the merge guards (which require a price + parentVariantId) and any
    // metafield write.
    const existing = bundleRow({ operation: 'update' });
    const shopDb = mockDb({ id: 'shop-abc' });
    const updateDb = mockDb(existing);
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(updateDb);

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
    const json = (await res.json()) as { bundle: { id: string; price: number; updated: string } };
    expect(json.bundle.id).toBe('bundle-1');
    expect(json.bundle.price).toBe(19.99);
    expect(json.bundle.updated).toBe('Just now');
    expect(updateDb.update).toHaveBeenCalled();
  });

  it('PUT /api/bundles/:id returns 404 for missing/other-shop bundle', async () => {
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(null));

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
    const shopDb = mockDb({ id: 'shop-abc' });
    const deleteDb = mockDb(bundleRow());
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(deleteDb);

    const res = await app.request(
      '/api/bundles/bundle-1',
      { method: 'DELETE', headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteDb.delete).toHaveBeenCalled();
  });

  it('DELETE /api/bundles/:id returns 404 for missing/other-shop bundle', async () => {
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(null));

    const res = await app.request(
      '/api/bundles/ghost',
      { method: 'DELETE', headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/bundles writes composition for an expand bundle with a parentVariantId', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    // Reused inside the route for the insert, the shopDomain lookup, and the
    // post-write metafieldState update — a single row shape covers all three.
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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

    expect(adminGraphql).toHaveBeenCalledTimes(1);
    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[0];
    expect(query).toContain('metafieldsSet');
    expect(variables).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'composition' })],
    });
  });

  it('POST /api/bundles writes $app:cart-transform.merge_bundles (never composition) for a merge bundle', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    expect(writeQuery).toContain('metafieldsSet');
    expect(writeVars).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'merge_bundles' })],
    });
    expect(writeVars).not.toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'composition' })],
    });
  });

  it('POST /api/bundles returns 400 with a JSON error when a merge bundle has no price', async () => {
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));

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
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));

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
    const shopDb = mockDb({ id: 'shop-abc' });
    // Reused inside the route for the insert, the shopDomain lookup, and the
    // post-write metafieldState update — a single row shape covers all three.
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
      price: 49.99,
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

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    expect(writeQuery).toContain('metafieldsSet');
    expect(writeVars).toEqual({
      metafields: [expect.objectContaining({ namespace: '$app:cart-transform', key: 'merge_bundles' })],
    });
  });

  it('POST /api/bundles returns a 502 JSON error when the metafield write fails', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
  });

  it('GET /api/bundles/:id/admin-url resolves the parent variant\'s product into an admin URL', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const bundleDb = mockDb(bundleRow({ parentVariantId: 'gid://shopify/ProductVariant/999' }));
    const shopDomainDb = mockDb({ domain: 'mystore.myshopify.com' });
    // requireShop -> getCurrentShopId (1), route bundle lookup (2), requireShopDomain (3).
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(bundleDb).mockReturnValueOnce(shopDomainDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const bundleDb = mockDb(bundleRow({ parentVariantId: null }));
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(bundleDb);

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
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb(null));

    const res = await app.request(
      '/api/bundles/ghost/admin-url',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });

  it('GET /api/bundles/activation returns {active:true} when ensureCartTransform resolves a gid', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    // requireShop -> getCurrentShopId (1), route's requireShopDomain (2).
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const updateDb = mockDb(existing);
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(updateDb);

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
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('PUT /api/bundles/:id transitions expand -> merge: clears composition and writes $app:cart-transform.merge_bundles', async () => {
    const existing = bundleRow({
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/999',
      metafieldState: 'Written',
      metafieldGid: 'gid://shopify/Metafield/1',
      price: 4999,
    });
    const shopDb = mockDb({ id: 'shop-abc' });
    // Same reuse pattern as the other PUT tests: this single row shape covers
    // the existing-bundle select AND the requireShopDomain select AND both
    // post-write updates (`.domain` for the latter, the bundle fields for the
    // former).
    const routeDb = mockDb({ ...existing, domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);

    // Call order: clearComposition (metafieldsDelete) for the OLD transport,
    // then upsertMergeConfig's read + write for the NEW transport.
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
      price: 39.99,
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

    expect(adminGraphql).toHaveBeenCalledTimes(3);
    const [, , clearQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(clearQuery).toContain('metafieldsDelete');
    const [, , readQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(readQuery).toContain('merge_bundles');
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[2];
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
    });
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ ...existing, domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);

    const oldEntry = {
      parentVariantId: OLD_PARENT,
      price: 29.99,
      sources: ['gid://shopify/ProductVariant/1'],
    };
    // Call order: removeMergeConfig's read + write for the OLD parent (Phase
    // 1, the fix under test), then upsertMergeConfig's read + write for the
    // NEW parent (Phase 2).
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

    // Phase 1 — the OLD parent's entry is removed (read + metafieldsDelete,
    // since it was the only entry in the array).
    expect(adminGraphql).toHaveBeenCalledTimes(4);
    const [, , removeReadQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(removeReadQuery).toContain('merge_bundles');
    const [, , removeWriteQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(removeWriteQuery).toContain('metafieldsDelete');

    // Phase 2 — the NEW parent's entry is written.
    const [, , upsertReadQuery] = vi.mocked(adminGraphql).mock.calls[2];
    expect(upsertReadQuery).toContain('merge_bundles');
    const [, , upsertWriteQuery, upsertWriteVars] = vi.mocked(adminGraphql).mock.calls[3];
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
    const shopDb = mockDb({ id: 'shop-abc' });
    const routeDb = mockDb({ ...existing, domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(routeDb);

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
    const shopDb = mockDb({ id: 'shop-abc' });
    const deleteDb = mockDb({ ...existing, domain: 'mystore.myshopify.com' });
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(deleteDb);

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
    expect(deleteDb.delete).toHaveBeenCalled();

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , readQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(readQuery).toContain('merge_bundles');
    const [, , deleteQuery] = vi.mocked(adminGraphql).mock.calls[1];
    expect(deleteQuery).toContain('metafieldsDelete');
  });
});

describe('GET /api/variants (batch variant name + admin URL resolution)', () => {
  beforeEach(() => vi.clearAllMocks());

  const V1 = 'gid://shopify/ProductVariant/111';
  const V2 = 'gid://shopify/ProductVariant/222';

  /** requireShop -> getCurrentShopId (1), route's requireShopDomain (2). */
  const mockShopChain = () => {
    vi.mocked(createDb)
      .mockReturnValueOnce(mockDb({ id: 'shop-abc' }))
      .mockReturnValueOnce(mockDb({ domain: 'mystore.myshopify.com' }));
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
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));
    const res = await request('');

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toEqual(expect.any(String));
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-ProductVariant gid', async () => {
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));
    const res = await request(`?ids=${encodeURIComponent('gid://shopify/Product/456')}`);

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns 400 when more than 50 ids are requested', async () => {
    vi.mocked(createDb).mockReturnValueOnce(mockDb({ id: 'shop-abc' }));
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
    vi.mocked(createDb).mockReturnValue(mockDb(null));
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
