import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({
  adminGraphql: vi.fn(),
}));

import { adminGraphql } from './graphqlAdmin';
import { compositionFromItems, writeComposition, clearComposition } from './bundleMetafields';
import type { Env } from '../types/env';

describe('compositionFromItems', () => {
  it('normalizes a bare numeric variantId to a GID', () => {
    const result = compositionFromItems([{ variantId: '123', qty: 2, price: 149 }]);
    expect(result).toEqual([{ id: 'gid://shopify/ProductVariant/123', quantity: 2, price: 149 }]);
  });

  it('passes an already-GID variantId through unchanged', () => {
    const result = compositionFromItems([
      { variantId: 'gid://shopify/ProductVariant/456', qty: 1, price: 10.5 },
    ]);
    expect(result).toEqual([{ id: 'gid://shopify/ProductVariant/456', quantity: 1, price: 10.5 }]);
  });

  it('maps multiple items preserving order, defaulting missing price to 0', () => {
    const result = compositionFromItems([
      { variantId: '111', qty: 1, price: 10 },
      { variantId: '222', qty: 3 },
    ]);
    expect(result).toEqual([
      { id: 'gid://shopify/ProductVariant/111', quantity: 1, price: 10 },
      { id: 'gid://shopify/ProductVariant/222', quantity: 3, price: 0 },
    ]);
  });

  it('returns an empty array for no items', () => {
    expect(compositionFromItems([])).toEqual([]);
  });
});

describe('writeComposition', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';
  const parentVariantGid = 'gid://shopify/ProductVariant/999';

  beforeEach(() => vi.clearAllMocks());

  it('calls metafieldsSet with namespace bundle / key composition_v2 / type json and the stringified composition', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldsSet: {
          metafields: [{ id: 'gid://shopify/Metafield/1' }],
          userErrors: [],
        },
      },
    });

    const items = [{ variantId: '123', qty: 2, price: 149 }];
    const result = await writeComposition(env, shopDomain, parentVariantGid, items);

    expect(result).toEqual({ metafieldGid: 'gid://shopify/Metafield/1' });
    expect(adminGraphql).toHaveBeenCalledTimes(1);
    const [calledShopDomain, calledEnv, calledQuery, calledVariables] = vi.mocked(adminGraphql).mock.calls[0];
    expect(calledShopDomain).toBe(shopDomain);
    expect(calledEnv).toBe(env);
    expect(calledQuery).toContain('metafieldsSet');
    expect(calledVariables).toEqual({
      metafields: [
        {
          ownerId: parentVariantGid,
          namespace: 'bundle',
          key: 'composition_v2',
          type: 'json',
          value: JSON.stringify([{ id: 'gid://shopify/ProductVariant/123', quantity: 2, price: 149 }]),
        },
      ],
    });
  });

  it('throws loudly on metafieldsSet userErrors', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: ['metafields', '0', 'value'], message: 'bad value' }],
        },
      },
    });

    await expect(
      writeComposition(env, shopDomain, parentVariantGid, [{ variantId: '1', qty: 1, price: 1 }]),
    ).rejects.toThrow(/userErrors/);
  });

  it('throws loudly when no metafield id comes back', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { metafieldsSet: { metafields: [], userErrors: [] } },
    });

    await expect(
      writeComposition(env, shopDomain, parentVariantGid, [{ variantId: '1', qty: 1, price: 1 }]),
    ).rejects.toThrow(/no metafield id/);
  });

  it('throws loudly on top-level GraphQL errors', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      errors: [{ message: 'boom' }],
    });

    await expect(
      writeComposition(env, shopDomain, parentVariantGid, [{ variantId: '1', qty: 1, price: 1 }]),
    ).rejects.toThrow(/GraphQL errors/);
  });
});

describe('clearComposition', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';
  const parentVariantGid = 'gid://shopify/ProductVariant/999';

  beforeEach(() => vi.clearAllMocks());

  it('calls metafieldsDelete identifying the metafield by ownerId + namespace + key', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldsDelete: {
          deletedMetafields: [{ key: 'composition_v2', namespace: 'bundle', ownerId: parentVariantGid }],
          userErrors: [],
        },
      },
    });

    await clearComposition(env, shopDomain, parentVariantGid);

    expect(adminGraphql).toHaveBeenCalledTimes(1);
    const [calledShopDomain, calledEnv, calledQuery, calledVariables] = vi.mocked(adminGraphql).mock.calls[0];
    expect(calledShopDomain).toBe(shopDomain);
    expect(calledEnv).toBe(env);
    expect(calledQuery).toContain('metafieldsDelete');
    expect(calledVariables).toEqual({
      metafields: [{ ownerId: parentVariantGid, namespace: 'bundle', key: 'composition_v2' }],
    });
  });

  it('throws loudly on metafieldsDelete userErrors', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldsDelete: {
          deletedMetafields: null,
          userErrors: [{ field: ['metafields', '0'], message: 'not found' }],
        },
      },
    });

    await expect(clearComposition(env, shopDomain, parentVariantGid)).rejects.toThrow(/userErrors/);
  });
});
