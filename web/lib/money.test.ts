import { describe, it, expect } from 'vitest';
import { formatMoney, moneyAmount } from './money';

describe('formatMoney', () => {
  it('formats in the currency it is given, not a hardcoded dollar', () => {
    expect(formatMoney({ amount: '29.99', currencyCode: 'AUD' }, 'en-AU')).toBe('$29.99');
    expect(formatMoney({ amount: '1000', currencyCode: 'JPY' }, 'en-AU')).toContain('1,000');
  });

  it('renders an em dash for an absent amount rather than $0.00', () => {
    expect(formatMoney(null)).toBe('—');
  });

  it('never guesses a currency: an unresolved shop currency renders as the em dash, not a dollar sign', () => {
    // Mirrors BundleEditor's showMoney: before planData.currencyCode has
    // loaded, currencyCode is undefined, and the caller must fall back to
    // formatMoney(null) rather than guessing e.g. 'USD'.
    const currencyCode: string | undefined = undefined;
    const amount = 42;
    const rendered = currencyCode !== undefined
      ? formatMoney({ amount: String(amount), currencyCode })
      : formatMoney(null);
    expect(rendered).toBe('—');
    expect(rendered).not.toContain('$');
  });
});

describe('moneyAmount', () => {
  it('parses the decimal string for arithmetic', () => {
    expect(moneyAmount({ amount: '29.99', currencyCode: 'AUD' })).toBe(29.99);
  });

  it('passes null through', () => {
    expect(moneyAmount(null)).toBeNull();
  });
});
