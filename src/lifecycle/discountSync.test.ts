import { describe, it, expect } from 'vitest';
import { classifyNode, countProducts, kindAndConfig, mapMethod, mapStatus } from './discountSync';

describe('mapMethod', () => {
  it.each([
    ['DiscountAutomaticApp', 'automatic'],
    ['DiscountAutomaticBasic', 'automatic'],
    ['DiscountCodeApp', 'code'],
    ['DiscountCodeBxgy', 'code'],
  ])('%s -> %s', (typename, expected) => {
    expect(mapMethod(typename)).toBe(expected);
  });

  it('returns null for an unknown typename', () => {
    expect(mapMethod('SomethingElse')).toBeNull();
  });
});

describe('mapStatus', () => {
  it('ACTIVE -> active; everything else -> inactive', () => {
    expect(mapStatus('ACTIVE')).toBe('active');
    expect(mapStatus('SCHEDULED')).toBe('inactive');
    expect(mapStatus('EXPIRED')).toBe('inactive');
    expect(mapStatus(undefined)).toBe('inactive');
  });
});

describe('kindAndConfig', () => {
  it('detects the tier config namespace', () => {
    const res = kindAndConfig({ discount: null, tier: { value: '{"rule_type":"tier-discount"}' } });
    expect(res?.kind).toBe('tier');
    expect(res?.config).toEqual({ rule_type: 'tier-discount' });
  });

  it('returns null when no app config metafield is present (native discount)', () => {
    expect(kindAndConfig({ discount: null })).toBeNull();
  });

  it('tolerates malformed JSON', () => {
    const res = kindAndConfig({ discount: null, bundle: { value: 'not json' } });
    expect(res?.kind).toBe('bundle');
    expect(res?.config).toEqual({});
  });
});

describe('countProducts', () => {
  it('counts distinct tier target ids across levels', () => {
    const config = {
      discount_tiers: {
        '10': { targets: [1, 2, 3] },
        '20': { targets: [3, 4] }, // 3 is shared
      },
    };
    expect(countProducts('tier', config)).toBe(4);
  });

  it('counts bundle target variants + product ids', () => {
    const config = {
      bundle_discounts: [{ target_variants: [11, 12], target_product_ids: [99] }],
    };
    expect(countProducts('bundle', config)).toBe(3);
  });

  it('counts special target sets', () => {
    const config = {
      special_discounts: [{ targets: [{ target_variants: [7, 8] }, { target_variants: [8, 9] }] }],
    };
    expect(countProducts('special', config)).toBe(3);
  });

  it('returns 0 for empty/unknown config', () => {
    expect(countProducts('tier', {})).toBe(0);
  });
});

describe('classifyNode', () => {
  it('classifies an app-owned automatic tier discount', () => {
    const c = classifyNode({
      discount: { __typename: 'DiscountAutomaticApp', title: 'Volume 10%', status: 'ACTIVE', updatedAt: '2026-01-01T00:00:00Z' },
      tier: { value: JSON.stringify({ discount_tiers: { '10': { targets: [1, 2] } } }) },
    });
    expect(c).toMatchObject({
      isAppOwned: true,
      name: 'Volume 10%',
      method: 'automatic',
      status: 'active',
      type: 'tier',
      products: 2,
    });
  });

  it('marks a native discount (no app metafield) as not owned', () => {
    const c = classifyNode({
      discount: { __typename: 'DiscountCodeBasic', title: 'SAVE10', status: 'SCHEDULED' },
    });
    expect(c.isAppOwned).toBe(false);
    expect(c.type).toBeNull();
    expect(c.status).toBe('inactive');
    expect(c.products).toBe(0);
  });

  it('falls back to the payload name when the node has no title', () => {
    const c = classifyNode({ discount: null }, 'Fallback name');
    expect(c.name).toBe('Fallback name');
  });
});
