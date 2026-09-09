import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({
  adminGraphql: vi.fn(),
}));

import { adminGraphql } from './graphqlAdmin';
import {
  compositionFromItems,
  writeComposition,
  clearComposition,
  mergeConfigEntry,
  upsertMergeConfig,
  removeMergeConfig,
} from './bundleMetafields';
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

  it('rounds a non-integer qty to the nearest integer (Rust quantity is i64)', () => {
    const result = compositionFromItems([{ variantId: '1', qty: 2.5, price: 10 }]);
    expect(result).toEqual([{ id: 'gid://shopify/ProductVariant/1', quantity: 3, price: 10 }]);
    expect(Number.isInteger(result[0].quantity)).toBe(true);
  });

  it('clamps a zero/negative/non-finite qty up to 1', () => {
    const result = compositionFromItems([
      { variantId: '1', qty: 0, price: 1 },
      { variantId: '2', qty: -3, price: 1 },
      { variantId: '3', qty: NaN, price: 1 },
      { variantId: '4', qty: Infinity, price: 1 },
    ]);
    expect(result.map((r) => r.quantity)).toEqual([1, 1, 1, 1]);
  });

  it('falls back a non-finite price to 0', () => {
    const result = compositionFromItems([
      { variantId: '1', qty: 1, price: NaN },
      { variantId: '2', qty: 1, price: Infinity },
    ]);
    expect(result.map((r) => r.price)).toEqual([0, 0]);
    expect(result.every((r) => Number.isFinite(r.price))).toBe(true);
  });
});

describe('writeComposition', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';
  const parentVariantGid = 'gid://shopify/ProductVariant/999';

  beforeEach(() => vi.clearAllMocks());

  it('calls metafieldsSet with namespace $app:cart-transform / key composition / type json and the stringified composition', async () => {
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
          namespace: '$app:cart-transform',
          key: 'composition',
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
          deletedMetafields: [{ key: 'composition', namespace: '$app:cart-transform', ownerId: parentVariantGid }],
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
      metafields: [{ ownerId: parentVariantGid, namespace: '$app:cart-transform', key: 'composition' }],
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

describe('mergeConfigEntry', () => {
  it('builds an entry with a normalized parentVariantId and GID sources', () => {
    const result = mergeConfigEntry({
      parentVariantId: '999',
      price: 49.99,
      items: [
        { variantId: '1', qty: 1 },
        { variantId: 'gid://shopify/ProductVariant/2', qty: 1 },
      ],
    });
    expect(result).toEqual({
      parentVariantId: 'gid://shopify/ProductVariant/999',
      price: 49.99,
      sources: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
    });
  });

  it('dedupes items that repeat the same variantId into a single source entry', () => {
    const result = mergeConfigEntry({
      parentVariantId: 'gid://shopify/ProductVariant/999',
      price: 10,
      items: [
        { variantId: '1', qty: 1 },
        { variantId: '1', qty: 2 },
        { variantId: 'gid://shopify/ProductVariant/1', qty: 1 }, // same variant, GID form
        { variantId: '2', qty: 1 },
      ],
    });
    expect(result.sources).toEqual(['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2']);
  });

  it('includes title only when present on the bundle', () => {
    const withTitle = mergeConfigEntry({
      parentVariantId: '999',
      price: 10,
      items: [{ variantId: '1', qty: 1 }],
      title: 'Camp Kit',
    });
    expect(withTitle.title).toBe('Camp Kit');

    const withoutTitle = mergeConfigEntry({ parentVariantId: '999', price: 10, items: [{ variantId: '1', qty: 1 }] });
    expect(withoutTitle).not.toHaveProperty('title');
  });
});

describe('upsertMergeConfig', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';
  const shopGid = 'gid://shopify/Shop/1';
  const entry = {
    parentVariantId: 'gid://shopify/ProductVariant/999',
    price: 49.99,
    sources: ['gid://shopify/ProductVariant/1'],
  };

  beforeEach(() => vi.clearAllMocks());

  it('reads the current array, appends the entry (no prior match), and writes it back', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: shopGid, metafield: null } } })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } },
      });

    const result = await upsertMergeConfig(env, shopDomain, entry);

    expect(result).toEqual({ metafieldGid: 'gid://shopify/Metafield/1' });
    expect(adminGraphql).toHaveBeenCalledTimes(2);

    const [, , readQuery] = vi.mocked(adminGraphql).mock.calls[0];
    expect(readQuery).toContain('merge_bundles');

    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    expect(writeQuery).toContain('metafieldsSet');
    expect(writeVars).toEqual({
      metafields: [
        {
          ownerId: shopGid,
          namespace: '$app:cart-transform',
          key: 'merge_bundles',
          type: 'json',
          value: JSON.stringify([entry]),
        },
      ],
    });
  });

  it('replaces an existing entry with the same parentVariantId rather than duplicating it', async () => {
    const staleEntry = { parentVariantId: entry.parentVariantId, price: 39.99, sources: ['gid://shopify/ProductVariant/1'] };
    const otherEntry = { parentVariantId: 'gid://shopify/ProductVariant/111', price: 5, sources: [] };
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shop: { id: shopGid, metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify([staleEntry, otherEntry]) } } },
      })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } },
      });

    await upsertMergeConfig(env, shopDomain, entry);

    const [, , , writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    const value = JSON.parse((writeVars as { metafields: Array<{ value: string }> }).metafields[0].value);
    expect(value).toEqual([otherEntry, entry]);
  });

  it('treats a missing/invalid existing metafield value as an empty array', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shop: { id: shopGid, metafield: { id: 'gid://shopify/Metafield/1', value: 'not json' } } },
      })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } },
      });

    await upsertMergeConfig(env, shopDomain, entry);

    const [, , , writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    const value = JSON.parse((writeVars as { metafields: Array<{ value: string }> }).metafields[0].value);
    expect(value).toEqual([entry]);
  });

  it('throws loudly when the read has no shop id', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({ data: { shop: null } });
    await expect(upsertMergeConfig(env, shopDomain, entry)).rejects.toThrow(/no shop id/);
  });

  it('throws loudly on read GraphQL errors', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({ errors: [{ message: 'boom' }] });
    await expect(upsertMergeConfig(env, shopDomain, entry)).rejects.toThrow(/GraphQL errors/);
  });

  it('throws loudly on write metafieldsSet userErrors', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shop: { id: shopGid, metafield: null } } })
      .mockResolvedValueOnce({
        data: {
          metafieldsSet: { metafields: null, userErrors: [{ field: ['metafields', '0', 'value'], message: 'bad value' }] },
        },
      });
    await expect(upsertMergeConfig(env, shopDomain, entry)).rejects.toThrow(/userErrors/);
  });
});

describe('removeMergeConfig', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';
  const shopGid = 'gid://shopify/Shop/1';
  const parentVariantId = 'gid://shopify/ProductVariant/999';

  beforeEach(() => vi.clearAllMocks());

  it('filters the matching entry out and writes the remaining array back', async () => {
    const remaining = { parentVariantId: 'gid://shopify/ProductVariant/111', price: 5, sources: [] };
    const removed = { parentVariantId, price: 49.99, sources: ['gid://shopify/ProductVariant/1'] };
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shop: { id: shopGid, metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify([removed, remaining]) } } },
      })
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } },
      });

    await removeMergeConfig(env, shopDomain, parentVariantId);

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , writeQuery, writeVars] = vi.mocked(adminGraphql).mock.calls[1];
    expect(writeQuery).toContain('metafieldsSet');
    const value = JSON.parse((writeVars as { metafields: Array<{ value: string }> }).metafields[0].value);
    expect(value).toEqual([remaining]);
  });

  it('clears the metafield via metafieldsDelete when no entries remain', async () => {
    const removed = { parentVariantId, price: 49.99, sources: ['gid://shopify/ProductVariant/1'] };
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shop: { id: shopGid, metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify([removed]) } } },
      })
      .mockResolvedValueOnce({
        data: { metafieldsDelete: { deletedMetafields: [{ key: 'merge_bundles', namespace: '$app:cart-transform', ownerId: shopGid }], userErrors: [] } },
      });

    await removeMergeConfig(env, shopDomain, parentVariantId);

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    const [, , deleteQuery, deleteVars] = vi.mocked(adminGraphql).mock.calls[1];
    expect(deleteQuery).toContain('metafieldsDelete');
    expect(deleteVars).toEqual({
      metafields: [{ ownerId: shopGid, namespace: '$app:cart-transform', key: 'merge_bundles' }],
    });
  });

  it('throws loudly on metafieldsDelete userErrors', async () => {
    const removed = { parentVariantId, price: 49.99, sources: [] };
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shop: { id: shopGid, metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify([removed]) } } },
      })
      .mockResolvedValueOnce({
        data: {
          metafieldsDelete: { deletedMetafields: null, userErrors: [{ field: ['metafields', '0'], message: 'not found' }] },
        },
      });
    await expect(removeMergeConfig(env, shopDomain, parentVariantId)).rejects.toThrow(/userErrors/);
  });
});
