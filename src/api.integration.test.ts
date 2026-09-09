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

import { app } from './index';
import { createDb } from './db/db';
import { adminGraphql } from './lib/graphqlAdmin';

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

    const body = {
      name: 'Camp Kit',
      operation: 'merge',
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
    const existing = bundleRow();
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

  it('POST /api/bundles writes composition_v2 for an expand bundle with a parentVariantId', async () => {
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
      metafields: [expect.objectContaining({ namespace: 'bundle', key: 'composition_v2' })],
    });
  });

  it('POST /api/bundles does not write composition_v2 for a merge bundle', async () => {
    const shopDb = mockDb({ id: 'shop-abc' });
    const insertDb = mockDb(null);
    vi.mocked(createDb).mockReturnValueOnce(shopDb).mockReturnValueOnce(insertDb);

    const body = {
      name: 'Camp Kit',
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

    expect(res.status).toBe(201);
    const json = (await res.json()) as { bundle: { metafieldState: string } };
    expect(json.bundle.metafieldState).toBe('NotYet');
    expect(adminGraphql).not.toHaveBeenCalled();
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

  it('PUT /api/bundles/:id does not re-write composition_v2 on a rename-only update', async () => {
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
});
