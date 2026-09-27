import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({
  adminGraphql: vi.fn(),
}));

import { adminGraphql } from './graphqlAdmin';
import { ensureCartTransform } from './cartTransformRegistration';
import type { Env } from '../types/env';
import { InMemoryShopRepository, shopRow } from '../db/repositories/inMemory';

/**
 * A real (in-memory) shop repository rather than a stubbed Drizzle chain, so
 * these tests assert on the row `ensureCartTransform` leaves behind rather than
 * on the query shape it used to get there.
 */
function fakeShops(cartTransformGid: string | null) {
  return new InMemoryShopRepository([shopRow({ id: 'shop-1', cartTransformGid })]);
}

/** The gid persisted on the shop row, or null if nothing was written. */
function storedGid(shops: InMemoryShopRepository): string | null {
  return shops.rows[0].cartTransformGid;
}

describe('ensureCartTransform', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';
  const shopId = 'shop-1';

  beforeEach(() => vi.clearAllMocks());

  /**
   * Drives both Admin queries: which function is ours, and which transforms the
   * shop currently has. `transforms` is what Shopify reports — NOT what the
   * shop row claims, which is the distinction these tests exist for.
   */
  function mockShopify(transforms: Array<{ id: string; functionId: string }>, createdId?: string) {
    vi.mocked(adminGraphql).mockImplementation(async (_shop, _env, query: string) => {
      if (query.includes('shopifyFunctions')) {
        return {
          data: {
            shopifyFunctions: {
              nodes: [{ id: 'gid://shopify/Function/abc', title: 'cart-transformer', apiType: 'cart_transform' }],
            },
          },
        };
      }
      if (query.includes('cartTransforms')) {
        return { data: { cartTransforms: { nodes: transforms } } };
      }
      if (query.includes('cartTransformCreate')) {
        return { data: { cartTransformCreate: { cartTransform: { id: createdId }, userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });
  }

  it('keeps the stored gid when Shopify confirms the transform still exists', async () => {
    const shops = fakeShops('gid://shopify/CartTransform/1');
    mockShopify([{ id: 'gid://shopify/CartTransform/1', functionId: 'gid://shopify/Function/abc' }]);

    const result = await ensureCartTransform(env, shopDomain, shops, shopId);

    expect(result).toEqual({ gid: 'gid://shopify/CartTransform/1', created: false });
    expect(storedGid(shops)).toBe('gid://shopify/CartTransform/1');
  });

  // The defect this replaces: the old code returned the stored gid without ever
  // asking Shopify. A transform deleted on Shopify's side — app reinstall, a
  // changed function id — left the app permanently believing it was registered.
  // The Function was then never invoked, the metafield sat there unread, and
  // nothing anywhere surfaced an error. The stored gid is a CACHE; Shopify is
  // the source of truth.
  it('recreates the transform when the stored gid no longer exists in Shopify', async () => {
    const shops = fakeShops('gid://shopify/CartTransform/deleted');
    mockShopify([], 'gid://shopify/CartTransform/fresh');

    const result = await ensureCartTransform(env, shopDomain, shops, shopId);

    expect(result).toEqual({ gid: 'gid://shopify/CartTransform/fresh', created: true });
    expect(storedGid(shops)).toBe('gid://shopify/CartTransform/fresh');
  });

  it('adopts the live transform when the stored gid is stale but another of ours exists', async () => {
    const shops = fakeShops('gid://shopify/CartTransform/deleted');
    mockShopify([{ id: 'gid://shopify/CartTransform/live', functionId: 'gid://shopify/Function/abc' }]);

    const result = await ensureCartTransform(env, shopDomain, shops, shopId);

    expect(result).toEqual({ gid: 'gid://shopify/CartTransform/live', created: false });
    expect(storedGid(shops)).toBe('gid://shopify/CartTransform/live');
  });

  it('adopts an existing transform matching our functionId and persists it (no create mutation)', async () => {
    const shops = fakeShops(null);

    vi.mocked(adminGraphql).mockImplementation(async (_shop, _env, query: string) => {
      if (query.includes('shopifyFunctions')) {
        return {
          data: {
            shopifyFunctions: {
              nodes: [{ id: 'gid://shopify/Function/abc', title: 'cart-transformer', apiType: 'cart_transform' }],
            },
          },
        };
      }
      if (query.includes('cartTransforms')) {
        return {
          data: {
            cartTransforms: {
              nodes: [{ id: 'gid://shopify/CartTransform/existing', functionId: 'gid://shopify/Function/abc' }],
            },
          },
        };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await ensureCartTransform(env, shopDomain, shops, shopId);

    expect(result).toEqual({ gid: 'gid://shopify/CartTransform/existing', created: false });
    expect(storedGid(shops)).toBe('gid://shopify/CartTransform/existing');
    expect(adminGraphql).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('cartTransformCreate'),
      expect.anything(),
    );
  });

  it('returns conflict when an existing transform belongs to a different function — no create, no persist', async () => {
    const shops = fakeShops(null);

    vi.mocked(adminGraphql).mockImplementation(async (_shop, _env, query: string) => {
      if (query.includes('shopifyFunctions')) {
        return {
          data: {
            shopifyFunctions: {
              nodes: [{ id: 'gid://shopify/Function/abc', title: 'cart-transformer', apiType: 'cart_transform' }],
            },
          },
        };
      }
      if (query.includes('cartTransforms')) {
        return {
          data: {
            cartTransforms: {
              nodes: [{ id: 'gid://shopify/CartTransform/foreign', functionId: 'gid://shopify/Function/other' }],
            },
          },
        };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await ensureCartTransform(env, shopDomain, shops, shopId);

    expect(result).toEqual({ conflict: true });
    expect(storedGid(shops)).toBeNull();
    expect(adminGraphql).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('cartTransformCreate'),
      expect.anything(),
    );
  });

  it('creates a cart transform when none exists and our function resolves, then persists the gid', async () => {
    const shops = fakeShops(null);

    vi.mocked(adminGraphql).mockImplementation(async (_shop, _env, query: string, variables) => {
      if (query.includes('shopifyFunctions')) {
        return {
          data: {
            shopifyFunctions: {
              nodes: [{ id: 'gid://shopify/Function/abc', title: 'cart-transformer', apiType: 'cart_transform' }],
            },
          },
        };
      }
      if (query.includes('cartTransformCreate')) {
        expect(variables).toEqual({ functionId: 'gid://shopify/Function/abc' });
        return {
          data: {
            cartTransformCreate: {
              cartTransform: { id: 'gid://shopify/CartTransform/new' },
              userErrors: [],
            },
          },
        };
      }
      if (query.includes('cartTransforms')) {
        return { data: { cartTransforms: { nodes: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await ensureCartTransform(env, shopDomain, shops, shopId);

    expect(result).toEqual({ gid: 'gid://shopify/CartTransform/new', created: true });
    expect(storedGid(shops)).toBe('gid://shopify/CartTransform/new');
  });

  it('throws loudly when the cart-transform function is not deployed', async () => {
    const shops = fakeShops(null);

    vi.mocked(adminGraphql).mockImplementation(async (_shop, _env, query: string) => {
      if (query.includes('shopifyFunctions')) {
        return { data: { shopifyFunctions: { nodes: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    await expect(ensureCartTransform(env, shopDomain, shops, shopId)).rejects.toThrow(
      /cart-transform function not deployed/,
    );
  });

  it('throws loudly on cartTransformCreate userErrors', async () => {
    const shops = fakeShops(null);

    vi.mocked(adminGraphql).mockImplementation(async (_shop, _env, query: string) => {
      if (query.includes('shopifyFunctions')) {
        return {
          data: {
            shopifyFunctions: {
              nodes: [{ id: 'gid://shopify/Function/abc', title: 'cart-transformer', apiType: 'cart_transform' }],
            },
          },
        };
      }
      if (query.includes('cartTransforms')) {
        return { data: { cartTransforms: { nodes: [] } } };
      }
      if (query.includes('cartTransformCreate')) {
        return {
          data: {
            cartTransformCreate: {
              cartTransform: null,
              userErrors: [{ field: ['functionId'], message: 'already exists' }],
            },
          },
        };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    await expect(ensureCartTransform(env, shopDomain, shops, shopId)).rejects.toThrow(/userErrors/);
  });
});
