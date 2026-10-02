import { describe, expect, it } from 'vitest';
import { uniqueCode, uniqueName } from './uniqueName';

describe('uniqueName', () => {
  it('leaves a name alone when nothing has taken it', () => {
    expect(uniqueName('BFCM 1', new Set())).toBe('BFCM 1');
  });

  it('numbers the first collision from 2, the way a person counts copies', () => {
    expect(uniqueName('BFCM 1', new Set(['BFCM 1']))).toBe('BFCM 1 (2)');
  });

  it('keeps counting past an existing numbered name', () => {
    // The bug this exists to prevent: a fixed suffix collides on the SECOND
    // clone, which is exactly when a merchant is iterating on a campaign.
    expect(uniqueName('BFCM 1', new Set(['BFCM 1', 'BFCM 1 (2)']))).toBe('BFCM 1 (3)');
  });

  it('skips a gap rather than reusing a freed number', () => {
    expect(uniqueName('BFCM 1', new Set(['BFCM 1', 'BFCM 1 (3)']))).toBe('BFCM 1 (2)');
  });

  it('counts from the ORIGINAL name, so suffixes never stack', () => {
    // Cloning a clone fed `"BFCM 1 (2)"` back in as the base and produced
    // `"BFCM 1 (2) (2)"`, then `"... (2) (2) (2)"`. The counter has to see
    // through an existing number to the name underneath it.
    expect(uniqueName('BFCM 1 (2)', new Set(['BFCM 1', 'BFCM 1 (2)']))).toBe('BFCM 1 (3)');
  });

  it('keeps a number that is part of the real name', () => {
    // "Buy 1 get 1" ends in a digit but not in a counted suffix; stripping it
    // would quietly rename the merchant's discount.
    expect(uniqueName('Buy 1 get 1', new Set())).toBe('Buy 1 get 1');
  });

  it('does not treat a different name as a collision', () => {
    expect(uniqueName('BFCM', new Set(['BFCM 1']))).toBe('BFCM');
  });
});

describe('uniqueCode', () => {
  it('leaves a free code alone', () => {
    expect(uniqueCode('SPRING20', new Set())).toBe('SPRING20');
  });

  it('numbers a taken code without parentheses or spaces', () => {
    // A shopper types this at checkout, so it has to stay code-shaped —
    // "SPRING20 (2)" would be a poor thing to print on a banner.
    const next = uniqueCode('SPRING20', new Set(['SPRING20']));

    expect(next).toBe('SPRING20-2');
    expect(next).toMatch(/^[A-Z0-9_-]+$/);
  });

  it('keeps counting past an existing numbered code', () => {
    expect(uniqueCode('SPRING20', new Set(['SPRING20', 'SPRING20-2']))).toBe('SPRING20-3');
  });
});
