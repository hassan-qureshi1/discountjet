import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { deleteDiscountInShopify } from './deleteDiscount';
import type { Env } from '../types/env';

const ENV = {} as Env;
const SHOP = 'test.myshopify.com';
const GID = 'gid://shopify/DiscountAutomaticNode/1';

beforeEach(() => vi.mocked(adminGraphql).mockReset());

describe('deleteDiscountInShopify', () => {
  it('deletes an automatic discount by its node id', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { discountAutomaticDelete: { deletedAutomaticDiscountId: GID, userErrors: [] } },
    } as never);

    await deleteDiscountInShopify(ENV, SHOP, GID, 'automatic');

    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[0];
    expect(String(query)).toContain('discountAutomaticDelete');
    expect(variables).toEqual({ id: GID });
  });

  it('uses the CODE mutation for a code discount', async () => {
    const codeGid = 'gid://shopify/DiscountCodeNode/2';
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { discountCodeDelete: { deletedCodeDiscountId: codeGid, userErrors: [] } },
    } as never);

    await deleteDiscountInShopify(ENV, SHOP, codeGid, 'code');

    const [, , query] = vi.mocked(adminGraphql).mock.calls[0];
    // The two are different mutations; sending an automatic delete for a code
    // discount silently deletes nothing and reports success.
    expect(String(query)).toContain('discountCodeDelete');
    expect(String(query)).not.toContain('discountAutomaticDelete');
  });

  it('throws on userErrors rather than reporting a delete that did not happen', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        discountAutomaticDelete: {
          deletedAutomaticDiscountId: null,
          userErrors: [{ field: ['id'], message: 'Discount not found' }],
        },
      },
    } as never);

    await expect(deleteDiscountInShopify(ENV, SHOP, GID, 'automatic'))
      .rejects.toThrow(/Discount not found/);
  });

  it('throws when Shopify returns no deleted id, so a caller never deletes its only record of it', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { discountAutomaticDelete: { deletedAutomaticDiscountId: null, userErrors: [] } },
    } as never);

    await expect(deleteDiscountInShopify(ENV, SHOP, GID, 'automatic')).rejects.toThrow();
  });
});
