import { describe, expect, it } from 'vitest';
import { ENGINE_ADAPTERS, getAdapter } from './adapters';
import type { TierFormData } from './tier';

const TIER_FORM: TierFormData = {
  message: 'Buy more save more',
  applyTo: 'price',
  discountType: 'percentage',
  productDiscountSelectionStrategy: 'MAXIMUM',
  platform: 'BOTH',
  tiers: [{
    id: 't1',
    value: '20',
    selectorType: 'variant_id',
    targets: JSON.stringify([{ variantId: '123', productTitle: 'Shirt' }]),
    min_qty: '3',
  }],
};

describe('ENGINE_ADAPTERS', () => {
  it('carries the exact wire contract each Rust function reads', () => {
    expect(ENGINE_ADAPTERS.tier).toMatchObject({
      type: 'tier', functionHandle: 'discount-tier', namespace: '$app:discount-tier', key: 'config',
    });
    expect(ENGINE_ADAPTERS.bundle).toMatchObject({
      type: 'bundle', functionHandle: 'discount-bundle', namespace: '$app:discount-bundle', key: 'config',
    });
    // NOT a typo: the special engine's rule_type uses an underscore while the
    // other two use hyphens. That is the Rust contract.
    expect(ENGINE_ADAPTERS.special).toMatchObject({
      type: 'special', functionHandle: 'discount-special', namespace: '$app:discount-special', key: 'config',
    });
  });

  it('serialises a tier form to the rule_type the function parses', () => {
    const json = JSON.parse(getAdapter('tier').serialize(TIER_FORM as never));
    expect(json.rule_type).toBe('tier-discount');
    expect(json.discount_tiers['20'].targets).toEqual([123]);
    expect(json.discount_tiers['20'].min_qty).toBe(3);
  });

  it('reports validation errors rather than throwing them', () => {
    const errors = getAdapter('tier').validate({ ...TIER_FORM, tiers: [] } as never);
    expect(errors.length).toBeGreaterThan(0);
  });

  // Review Focus #1 — the underlying getMetafieldValueString catches and
  // returns "{}". Server-side that creates a real discount with an empty
  // config: a promotion that silently does nothing at checkout.
  it('THROWS rather than emitting "{}" when a form cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => getAdapter('tier').serialize(circular as never)).toThrow();
  });

  it('measures size in bytes of the serialised config', () => {
    const adapter = getAdapter('tier');
    expect(adapter.sizeBytes(TIER_FORM as never)).toBe(
      new TextEncoder().encode(adapter.serialize(TIER_FORM as never)).length,
    );
    expect(adapter.maxBytes).toBe(10 * 1024);
  });

  // Review fix — validate() reads the FORM, buildXConfig drops rules it cannot
  // resolve. isActionable closes the gap on the built side.
  it('tier: a built config with an empty discount_tiers is not actionable', () => {
    const adapter = getAdapter('tier');
    expect(adapter.isActionable({ rule_type: 'tier-discount', discount_tiers: {} })).toBe(false);
    expect(adapter.isActionable(JSON.parse(adapter.serialize(TIER_FORM as never)))).toBe(true);
  });

  it('tier: a product_id tier whose items carry only variantId builds nothing actionable', () => {
    const adapter = getAdapter('tier');
    const form = {
      ...TIER_FORM,
      tiers: [{ ...TIER_FORM.tiers[0], selectorType: 'product_id' as const }],
    };
    expect(adapter.validate(form as never)).toEqual([]);
    expect(adapter.isActionable(JSON.parse(adapter.serialize(form as never)))).toBe(false);
  });

  it('tier: a non-numeric tier key is not actionable — engine.rs skips it', () => {
    const adapter = getAdapter('tier');
    expect(adapter.isActionable({ discount_tiers: { abc: { targets: [1] } } })).toBe(false);
    expect(adapter.isActionable({ discount_tiers: { '20': { targets: [1] } } })).toBe(true);
  });

  it('bundle: a built config with an empty bundle_discounts is not actionable', () => {
    const adapter = getAdapter('bundle');
    expect(adapter.isActionable({ rule_type: 'bundle-discount', bundle_discounts: [] })).toBe(false);
    expect(adapter.isActionable({ rule_type: 'bundle-discount', bundle_discounts: [{}] })).toBe(true);
  });

  it('special: a built config with an empty special_discounts is not actionable', () => {
    const adapter = getAdapter('special');
    expect(adapter.isActionable({ rule_type: 'special_discount', special_discounts: [] })).toBe(false);
    expect(adapter.isActionable({ rule_type: 'special_discount', special_discounts: [{}] })).toBe(true);
  });

  it('rejects an unknown engine type loudly', () => {
    expect(() => getAdapter('nope' as never)).toThrow();
  });
});
