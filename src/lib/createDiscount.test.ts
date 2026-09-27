import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { createDiscountInShopify } from './createDiscount';
import type { Env } from '../types/env';

const ENV = {} as Env;
const SHOP = 'test.myshopify.com';

const TIER_FORM = {
  message: '', applyTo: 'price', discountType: 'percentage',
  productDiscountSelectionStrategy: 'MAXIMUM', platform: 'BOTH',
  tiers: [{
    id: 't1', value: '20', selectorType: 'variant_id',
    targets: JSON.stringify([{ variantId: '123' }]), min_qty: '3',
  }],
};

function mockFunctionsThenCreate(payloadKey: 'discountAutomaticAppCreate' | 'discountCodeAppCreate') {
  const created = payloadKey === 'discountCodeAppCreate'
    ? { codeAppDiscount: { discountId: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] }
    : { automaticAppDiscount: { discountId: 'gid://shopify/DiscountAutomaticNode/1' }, userErrors: [] };
  vi.mocked(adminGraphql)
    .mockResolvedValueOnce({
      data: { shopifyFunctions: { nodes: [
        { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
      ] } },
    } as never)
    .mockResolvedValueOnce({ data: { [payloadKey]: created } } as never);
}

describe('createDiscountInShopify', () => {
  beforeEach(() => vi.mocked(adminGraphql).mockReset());

  it('creates an automatic discount and returns its id and serialized config', async () => {
    mockFunctionsThenCreate('discountAutomaticAppCreate');

    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'automatic',
      title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: true, discountId: 'gid://shopify/DiscountAutomaticNode/1' });
    if (!out.ok) throw new Error('expected ok');
    expect(JSON.parse(out.value).rule_type).toBe('tier-discount');
    expect(out.sizeBytes).toBeGreaterThan(0);

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.functionId).toBe('gid://shopify/Function/tier');
    expect(input.discountClasses).toEqual(['PRODUCT']);
    expect(input.startsAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('titles a code discount with its code', async () => {
    mockFunctionsThenCreate('discountCodeAppCreate');

    await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'code',
      title: 'ignored', code: 'SPRING20', startsAt: '2026-10-01T00:00:00.000Z',
    });

    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[1];
    expect(String(query)).toContain('discountCodeAppCreate');
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.title).toBe('SPRING20');
    expect(input.code).toBe('SPRING20');
    expect(input.discountClasses).toEqual(['PRODUCT']);
  });

  it('returns a 400 outcome for an invalid form, without calling Shopify', async () => {
    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: { ...TIER_FORM, tiers: [] }, method: 'automatic',
      title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns a 400 outcome for a config with no usable rules', async () => {
    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', method: 'automatic', title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
      // `product_id` selector with items carrying only a variantId: validate
      // passes, the builder resolves no ids, the config comes out empty.
      form: { ...TIER_FORM, tiers: [{
        id: 't1', value: '20', selectorType: 'product_id',
        targets: JSON.stringify([{ variantId: '123' }]), min_qty: '',
      }] },
    });

    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns a 502 outcome when the function is not deployed', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { shopifyFunctions: { nodes: [] } },
    } as never);

    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'automatic',
      title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: false, status: 502 });
  });

  it('returns a 502 outcome carrying Shopify userErrors', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'V', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountAutomaticAppCreate: { automaticAppDiscount: null, userErrors: [{ field: ['title'], message: 'Title is invalid' }] } },
      } as never);

    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'automatic',
      title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: false, status: 502 });
    if (out.ok) throw new Error('expected failure');
    expect(out.error).toContain('Title is invalid');
  });
});
