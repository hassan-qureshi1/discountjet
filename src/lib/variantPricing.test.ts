import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { readVariantPrice, setVariantPricing } from './variantPricing';
import type { Env } from '../types/env';

const env = {} as Env;
const SHOP = 'test-shop.myshopify.com';
const VARIANT = 'gid://shopify/ProductVariant/1';

beforeEach(() => vi.mocked(adminGraphql).mockReset());

describe('readVariantPrice', () => {
  it('returns the live price in minor units with the shop currency', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        productVariant: { id: VARIANT, price: '3100.00', product: { id: 'gid://shopify/Product/9' } },
        shop: { currencyCode: 'USD' },
      },
    } as never);

    await expect(readVariantPrice(env, SHOP, VARIANT)).resolves.toEqual({
      priceMinor: 310000, currencyCode: 'USD',
    });
  });

  it('returns null for a variant that no longer exists', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { productVariant: null, shop: { currencyCode: 'USD' } },
    } as never);

    await expect(readVariantPrice(env, SHOP, VARIANT)).resolves.toBeNull();
  });
});

describe('setVariantPricing', () => {
  it('writes price and compareAtPrice in major units for the product that owns the variant', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          productVariant: { id: VARIANT, price: '3100.00', product: { id: 'gid://shopify/Product/9' } },
          shop: { currencyCode: 'USD' },
        },
      } as never)
      .mockResolvedValueOnce({
        data: { productVariantsBulkUpdate: { productVariants: [{ id: VARIANT }], userErrors: [] } },
      } as never);

    await setVariantPricing(env, SHOP, VARIANT, {
      priceMinor: 279000, compareAtMinor: 310000, currencyCode: 'USD',
    });

    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[1];
    expect(String(query)).toContain('productVariantsBulkUpdate');
    expect(variables).toMatchObject({
      productId: 'gid://shopify/Product/9',
      variants: [{ id: VARIANT, price: '2790.00', compareAtPrice: '3100.00' }],
    });
  });

  it('throws on userErrors rather than reporting a write that did not happen', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          productVariant: { id: VARIANT, price: '3100.00', product: { id: 'gid://shopify/Product/9' } },
          shop: { currencyCode: 'USD' },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          productVariantsBulkUpdate: {
            productVariants: null,
            userErrors: [{ field: ['price'], message: 'Price must be positive' }],
          },
        },
      } as never);

    await expect(
      setVariantPricing(env, SHOP, VARIANT, {
        priceMinor: 279000, compareAtMinor: 310000, currencyCode: 'USD',
      }),
    ).rejects.toThrow(/Price must be positive/);
  });
});
