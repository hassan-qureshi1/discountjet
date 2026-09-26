import { describe, it, expect } from 'vitest';
import { currencyExponent, toMinorUnits, toMoney } from './money';

describe('currencyExponent', () => {
  it('reads the exponent from Intl rather than assuming 2', () => {
    expect(currencyExponent('AUD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('throws on a malformed currency instead of defaulting', () => {
    expect(() => currencyExponent('NOPE')).toThrow(/NOPE/);
    expect(() => currencyExponent('')).toThrow();
  });

  // Regression: this was read from Intl, which reports CLDR *display* digits.
  // Those differ between ICU builds — workerd resolved PKR to 0 while Node
  // resolved it to 2 — so the same amount was stored as 32 on the server and
  // meant 0.32 elsewhere. The exponent is a property of the currency, not of
  // whoever is rendering it.
  it('uses ISO 4217 minor units, not the runtime\'s CLDR display digits', () => {
    expect(currencyExponent('PKR')).toBe(2);
    expect(toMinorUnits('32.00', 'PKR')).toBe(3200);
    expect(toMoney(3200, 'PKR')).toEqual({ amount: '32.00', currencyCode: 'PKR' });
  });

  it('agrees with the value Intl would give for the common cases', () => {
    // Where CLDR and ISO 4217 concur, nothing changed.
    (['AUD', 'USD', 'EUR', 'JPY', 'KWD'] as const).forEach((code) => {
      const viaIntl = new Intl.NumberFormat('en', { style: 'currency', currency: code })
        .resolvedOptions().maximumFractionDigits;
      expect(currencyExponent(code)).toBe(viaIntl);
    });
  });
});

describe('toMinorUnits', () => {
  it('converts a decimal string without touching a float', () => {
    expect(toMinorUnits('29.99', 'AUD')).toBe(2999);
    expect(toMinorUnits('1000', 'JPY')).toBe(1000);
    expect(toMinorUnits('1.234', 'KWD')).toBe(1234);
  });

  it('pads a short fraction', () => {
    expect(toMinorUnits('5.1', 'AUD')).toBe(510);
    expect(toMinorUnits('7', 'AUD')).toBe(700);
  });

  it('rounds a fraction longer than the currency allows', () => {
    expect(toMinorUnits('1.005', 'AUD')).toBe(101);
    expect(toMinorUnits('1.004', 'AUD')).toBe(100);
  });

  it('rejects a non-numeric amount rather than coercing it', () => {
    expect(() => toMinorUnits('abc', 'AUD')).toThrow(/abc/);
  });
});

describe('toMoney', () => {
  it('round-trips minor units back to a decimal string', () => {
    expect(toMoney(2999, 'AUD')).toEqual({ amount: '29.99', currencyCode: 'AUD' });
    expect(toMoney(1000, 'JPY')).toEqual({ amount: '1000', currencyCode: 'JPY' });
    expect(toMoney(1234, 'KWD')).toEqual({ amount: '1.234', currencyCode: 'KWD' });
  });

  it('pads the fraction back out', () => {
    expect(toMoney(510, 'AUD')).toEqual({ amount: '5.10', currencyCode: 'AUD' });
    expect(toMoney(5, 'AUD')).toEqual({ amount: '0.05', currencyCode: 'AUD' });
  });

  it('passes null through — an absent amount is not zero', () => {
    expect(toMoney(null, 'AUD')).toBeNull();
  });
});
