import { describe, it, expect } from 'vitest';
import {
  shopifyStatusLabel,
  methodLabel,
  engineLabel,
  engineTypeLabel,
  nativeTypeLabel,
  toShopifyDiscount,
} from './shopifyDiscounts';

describe('shopifyStatusLabel', () => {
  it('preserves the Shopify tri-state', () => {
    expect(shopifyStatusLabel('ACTIVE')).toBe('Active');
    expect(shopifyStatusLabel('SCHEDULED')).toBe('Scheduled');
    expect(shopifyStatusLabel('EXPIRED')).toBe('Expired');
  });
  it('falls back to Active for an unknown status', () => {
    expect(shopifyStatusLabel(undefined)).toBe('Active');
  });
});

describe('methodLabel', () => {
  it('maps automatic and code typenames', () => {
    expect(methodLabel('DiscountAutomaticApp')).toBe('Automatic');
    expect(methodLabel('DiscountCodeBasic')).toBe('Code');
  });
});

describe('engineLabel', () => {
  it('maps engine kinds, with special rendered as Split', () => {
    expect(engineLabel('tier')).toBe('Tier');
    expect(engineLabel('bundle')).toBe('Bundle');
    expect(engineLabel('special')).toBe('Split');
  });
});

describe('engineTypeLabel', () => {
  it('renders merchant-facing engine type labels', () => {
    expect(engineTypeLabel('tier')).toBe('Discount Engine · Volume');
    expect(engineTypeLabel('bundle')).toBe('Discount Engine · Buy X, get Y');
    expect(engineTypeLabel('special')).toBe('Discount Engine · Buy X, discount both');
  });
});

describe('nativeTypeLabel', () => {
  it('maps native discount typenames to human labels', () => {
    expect(nativeTypeLabel('DiscountCodeBasic')).toBe('Amount off products');
    expect(nativeTypeLabel('DiscountAutomaticFreeShipping')).toBe('Free shipping');
    expect(nativeTypeLabel('DiscountCodeBxgy')).toBe('Buy X, get Y');
  });
});

describe('toShopifyDiscount', () => {
  const appIdByGid = new Map<string, string>([['gid://shopify/DiscountNode/1', 'row-1']]);

  it('maps an app-owned node with engine + appId joined from D1', () => {
    const dto = toShopifyDiscount(
      {
        id: 'gid://shopify/DiscountNode/1',
        discount: { __typename: 'DiscountAutomaticApp', title: 'Volume 10%', status: 'ACTIVE', asyncUsageCount: 128 },
        tier: { value: '{"discount_tiers":{}}' },
      },
      appIdByGid,
    );
    expect(dto).toEqual({
      id: 'gid://shopify/DiscountNode/1',
      title: 'Volume 10%',
      status: 'Active',
      method: 'Automatic',
      type: 'Discount Engine · Volume',
      engine: 'Tier',
      appId: 'row-1',
      used: 128,
    });
  });

  it('maps a native node with engine null and no appId', () => {
    const dto = toShopifyDiscount(
      {
        id: 'gid://shopify/DiscountNode/9',
        discount: { __typename: 'DiscountCodeBasic', title: 'SAVE10', status: 'SCHEDULED', asyncUsageCount: 5 },
      },
      appIdByGid,
    );
    expect(dto).toEqual({
      id: 'gid://shopify/DiscountNode/9',
      title: 'SAVE10',
      status: 'Scheduled',
      method: 'Code',
      type: 'Amount off products',
      engine: null,
      used: 5,
    });
  });

  it('treats an app-owned node not yet mirrored in D1 as having no appId', () => {
    const dto = toShopifyDiscount(
      {
        id: 'gid://shopify/DiscountNode/2',
        discount: { __typename: 'DiscountAutomaticApp', title: 'Bundle', status: 'ACTIVE', asyncUsageCount: 0 },
        bundle: { value: '{"bundle_discounts":[]}' },
      },
      appIdByGid,
    );
    expect(dto.engine).toBe('Bundle');
    expect(dto.appId).toBeUndefined();
  });
});
