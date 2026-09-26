import { describe, it, expect } from 'vitest';
import { gateOperation, getOp, OPERATIONS } from './ops';

// The gate behind the "Create bundle" chooser: it decides which operations a
// merchant can pick, and supplies the reason shown on the ones they cannot.
// Shopify's Cart Transform API allows `lineExpand` and `linesMerge` on every
// plan and restricts `lineUpdate` to development stores and Shopify Plus.
describe('gateOperation', () => {
  it('allows expand and merge regardless of plan', () => {
    [true, false].forEach((eligible) => {
      expect(gateOperation('expand', eligible)).toEqual({ enabled: true });
      expect(gateOperation('merge', eligible)).toEqual({ enabled: true });
    });
  });

  it('allows update only when the store is Plus-eligible', () => {
    expect(gateOperation('update', true)).toEqual({ enabled: true });
    expect(gateOperation('update', false).enabled).toBe(false);
  });

  it('gives a reason when update is unavailable, so the UI never just hides it', () => {
    // A capability that silently isn't there reads as a missing feature; the
    // reason is what makes it read as a plan limit.
    expect(gateOperation('update', false).reason).toMatch(/Plus/);
  });

  it('names the current plan in the reason when one is known', () => {
    // The API refuses this too, with the same wording. Two different
    // explanations for one refusal is worse than none.
    expect(gateOperation('update', false, 'Advanced').reason).toContain('Advanced');
  });

  it('falls back cleanly when the plan is unknown', () => {
    expect(gateOperation('update', false, null).reason).toBe('Requires Shopify Plus.');
  });

  it('does not leak a reason when an operation is allowed', () => {
    expect(gateOperation('expand', false).reason).toBeUndefined();
  });
});

describe('OPERATIONS', () => {
  it('describes exactly the three cart-transform operations', () => {
    expect(OPERATIONS.map((o) => o.id).sort()).toEqual(['expand', 'merge', 'update']);
  });

  it('gives every operation a label and a description for the chooser', () => {
    OPERATIONS.forEach((op) => {
      expect(op.label.length).toBeGreaterThan(0);
      expect(op.description.length).toBeGreaterThan(0);
    });
  });

  it('getOp throws on an unknown id rather than returning a blank row', () => {
    expect(() => getOp('nope' as never)).toThrow(/nope/);
  });
});
