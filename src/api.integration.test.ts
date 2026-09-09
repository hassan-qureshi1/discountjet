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
// to the given row (or null). Typed as the createDb return so call sites need
// no cast.
function mockDb(row: Record<string, unknown> | null): ReturnType<typeof createDb> {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => Promise.resolve(row),
        }),
      }),
    }),
  } as unknown as ReturnType<typeof createDb>;
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
