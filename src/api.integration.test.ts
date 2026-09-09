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

import { app } from './index';
import { createDb } from './db/db';

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
});
