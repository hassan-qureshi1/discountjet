import { describe, it, expect } from 'vitest';
import { isPlusPlan, planGateReason } from './shopPlan';

describe('isPlusPlan', () => {
  it('accepts the plan names Shopify reports for Plus', () => {
    ['Shopify Plus', 'shopify plus', 'PLUS'].forEach((plan) => {
      expect(isPlusPlan(plan)).toBe(true);
    });
  });

  it('rejects every non-Plus tier', () => {
    ['Basic', 'Shopify', 'Advanced', 'Starter', 'Developer Preview'].forEach((plan) => {
      expect(isPlusPlan(plan)).toBe(false);
    });
  });

  // A development store reports shopifyPlus=true to the Admin API, which is
  // why the gate reads the plan NAME instead: Shopify allows lineUpdate there,
  // but this app has no lineUpdate pass, so offering it would let a merchant
  // save a bundle that silently does nothing.
  it('rejects a partner development store', () => {
    expect(isPlusPlan('Developer Preview')).toBe(false);
    expect(isPlusPlan('Partner test store')).toBe(false);
  });

  it('treats an unknown plan as not eligible rather than assuming', () => {
    expect(isPlusPlan(null)).toBe(false);
    expect(isPlusPlan(undefined)).toBe(false);
    expect(isPlusPlan('')).toBe(false);
  });
});

describe('planGateReason', () => {
  it('names the current plan so the limit is not a mystery', () => {
    expect(planGateReason('Advanced')).toContain('Advanced');
  });

  it('falls back cleanly when the plan is unknown', () => {
    expect(planGateReason(null)).toBe('Requires Shopify Plus.');
  });
});
