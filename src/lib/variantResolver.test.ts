import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { resolveVariants, variantDisplayName } from './variantResolver';
import type { Env } from '../types/env';

const env = {} as Env;
const SHOP = 'test-shop.myshopify.com';
const GID = 'gid://shopify/ProductVariant/1';

beforeEach(() => vi.clearAllMocks());

describe('resolveVariants', () => {
  it('returns price alongside the titles', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { nodes: [{
        id: GID, title: 'Large', price: '29.99', image: null,
        product: { id: 'gid://shopify/Product/9', title: 'Blue T-Shirt', featuredImage: null },
      }] },
    } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    expect(resolved.get(GID)).toMatchObject({
      id: GID, exists: true, price: '29.99',
      productTitle: 'Blue T-Shirt', variantTitle: 'Large',
    });
  });

  it('exposes the storefront url Shopify reports for a published product', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { nodes: [{
        id: GID, title: 'Large', price: '29.99', image: null,
        product: {
          id: 'gid://shopify/Product/9',
          title: 'Blue T-Shirt',
          featuredImage: null,
          onlineStoreUrl: 'https://test-shop.myshopify.com/products/blue-t-shirt',
        },
      }] },
    } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    // Shopify's own published URL, not one we assemble from the handle: it is
    // the only value that respects a custom domain and an unpublished product.
    expect(resolved.get(GID)).toMatchObject({
      storefrontUrl: 'https://test-shop.myshopify.com/products/blue-t-shirt',
    });
  });

  it('falls back to the shop primary domain when the product has no onlineStoreUrl', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        nodes: [{
          id: GID, title: 'Large', price: '29.99', image: null,
          product: {
            id: 'gid://shopify/Product/9',
            title: 'Blue T-Shirt',
            handle: 'blue-t-shirt',
            featuredImage: null,
            // Shopify reports null for a product not published to the Online
            // Store. The merchant still wants a way through to the page.
            onlineStoreUrl: null,
          },
        }],
        shop: { primaryDomain: { url: 'https://shop.example.com' } },
      },
    } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    expect(resolved.get(GID)).toMatchObject({
      storefrontUrl: 'https://shop.example.com/products/blue-t-shirt',
    });
  });

  it('prefers onlineStoreUrl over the constructed fallback when both are available', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        nodes: [{
          id: GID, title: 'Large', price: '29.99', image: null,
          product: {
            id: 'gid://shopify/Product/9',
            title: 'Blue T-Shirt',
            handle: 'blue-t-shirt',
            featuredImage: null,
            onlineStoreUrl: 'https://shop.example.com/products/canonical-path',
          },
        }],
        shop: { primaryDomain: { url: 'https://shop.example.com' } },
      },
    } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    // Shopify's own url is authoritative — it survives a renamed handle.
    expect(resolved.get(GID)).toMatchObject({
      storefrontUrl: 'https://shop.example.com/products/canonical-path',
    });
  });

  it('omits the storefront url when there is no handle to build one from', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        nodes: [{
          id: GID, title: 'Large', price: '29.99', image: null,
          product: {
            id: 'gid://shopify/Product/9',
            title: 'Blue T-Shirt',
            handle: null,
            featuredImage: null,
            onlineStoreUrl: null,
          },
        }],
        shop: { primaryDomain: { url: 'https://shop.example.com' } },
      },
    } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    expect(resolved.get(GID)).not.toHaveProperty('storefrontUrl');
  });

  it('asks Shopify for onlineStoreUrl rather than deriving one from the handle', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [null] } } as never);

    await resolveVariants(SHOP, env, [GID]);

    const [, , query] = vi.mocked(adminGraphql).mock.calls[0];
    expect(String(query)).toContain('onlineStoreUrl');
  });

  it('marks a deleted variant as absent rather than omitting it', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [null] } } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    expect(resolved.get(GID)).toEqual({ id: GID, exists: false });
  });

  it('de-duplicates ids so a repeated variant costs one node', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [] } } as never);

    await resolveVariants(SHOP, env, [GID, GID]);

    expect(vi.mocked(adminGraphql).mock.calls[0][3]).toEqual({ ids: [GID] });
  });

  it('throws on GraphQL errors instead of returning a half-empty map', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ errors: [{ message: 'boom' }] } as never);

    await expect(resolveVariants(SHOP, env, [GID])).rejects.toThrow(/boom/);
  });

  it('resolves nothing without calling Shopify when given no ids', async () => {
    const resolved = await resolveVariants(SHOP, env, []);

    expect(resolved.size).toBe(0);
    expect(adminGraphql).not.toHaveBeenCalled();
  });
});

describe('variantDisplayName', () => {
  it('joins product and variant titles', () => {
    expect(variantDisplayName({
      id: GID, exists: true, productTitle: 'Blue T-Shirt', variantTitle: 'Large',
    })).toBe('Blue T-Shirt / Large');
  });

  it('is undefined for a variant that did not resolve', () => {
    expect(variantDisplayName({ id: GID, exists: false })).toBeUndefined();
  });
});
