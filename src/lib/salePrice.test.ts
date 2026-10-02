import { describe, expect, it } from 'vitest';
import { compareAtMinorFor, decideSaleAction } from './salePrice';

const base = { price: 279000, compareAtPrice: null, preSalePrice: null, componentSumMinor: 310000 };

describe('compareAtMinorFor', () => {
  it('uses the component sum when the merchant set no compare-at', () => {
    expect(compareAtMinorFor({ compareAtPrice: null, componentSumMinor: 310000 })).toBe(310000);
  });

  it("prefers the merchant's own compare-at when they set one", () => {
    expect(compareAtMinorFor({ compareAtPrice: 350000, componentSumMinor: 310000 })).toBe(350000);
  });
});

describe('decideSaleAction', () => {
  it('applies the sale price and the component sum when the window opens', () => {
    expect(decideSaleAction(base, true)).toEqual({
      kind: 'apply', priceMinor: 279000, compareAtMinor: 310000, capturePreSaleFrom: 'live',
    });
  });

  // Review Focus #1 — the failure that loses the real price for good.
  it('does NOT re-apply while already on sale, so pre_sale_price is never recaptured', () => {
    const onSale = { ...base, preSalePrice: 310000 };

    const action = decideSaleAction(onSale, true);

    expect(action.kind).toBe('none');
  });

  it('restores exactly the captured price when the window closes', () => {
    const onSale = { ...base, preSalePrice: 310000 };

    expect(decideSaleAction(onSale, false)).toEqual({
      kind: 'restore', priceMinor: 310000, compareAtMinor: 310000,
    });
  });

  it('does nothing when the window is closed and the bundle was never on sale', () => {
    expect(decideSaleAction(base, false).kind).toBe('none');
  });

  it('refuses to apply a sale with no bundle price rather than pricing at zero', () => {
    const action = decideSaleAction({ ...base, price: null }, true);

    expect(action.kind).toBe('none');
    if (action.kind !== 'none') throw new Error('expected none');
    expect(action.reason).toMatch(/price/i);
  });

  it('restores even when the bundle price was cleared meanwhile', () => {
    // The restore must not depend on the sale price still being set — the
    // captured original is all it needs.
    const action = decideSaleAction({ ...base, price: null, preSalePrice: 310000 }, false);

    expect(action).toMatchObject({ kind: 'restore', priceMinor: 310000 });
  });
});
