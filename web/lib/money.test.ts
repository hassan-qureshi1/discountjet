import { describe, it, expect } from 'vitest';
import { formatMoney, moneyAmount, currencySymbol } from './money';

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

describe('currencySymbol (the prefix on BundleEditor\'s money inputs)', () => {
  it('renders the shop\'s own symbol, not a hardcoded dollar', () => {
    expect(currencySymbol('JPY')).toBe('¥');
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('EUR')).toBe('€');
  });

  it('renders a bare $ for AUD rather than A$ — the narrow symbol, as a field prefix should be', () => {
    expect(currencySymbol('AUD')).toBe('$');
  });

  it('renders NO prefix when the shop currency has not loaded — never a guessed $', () => {
    const prefix = currencySymbol(undefined);
    expect(prefix).toBeUndefined();
    expect(prefix ?? '').not.toContain('$');
  });

  it('renders no prefix for an invalid currency code rather than throwing or guessing', () => {
    expect(currencySymbol('NOTACURRENCY')).toBeUndefined();
  });
});
