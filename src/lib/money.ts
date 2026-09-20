/**
 * Money helpers. All money in D1 is stored as integer MINOR UNITS — deliberately
 * not called "cents", because the number of minor units in a major unit depends
 * on the currency: JPY and KRW have 0, most currencies 2, KWD and BHD have 3.
 *
 * The exponent comes from Intl rather than a hand-maintained table. Workers ship
 * full ICU, so this resolves server-side exactly as it does in the browser.
 */

/** Shopify's MoneyV2 shape — an exact decimal string plus its currency. */
export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

/** Minor units per major unit, as a power of ten. AUD -> 2, JPY -> 0, KWD -> 3. */
export function currencyExponent(currencyCode: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode })
      .resolvedOptions().maximumFractionDigits!;
  } catch {
    // A shop row with a bad or missing currency is a data-integrity problem.
    // Defaulting to 2 would silently store JPY off by a factor of 100.
    throw new Error(`[money] unknown currency code: ${currencyCode}`);
  }
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d*))?$/;

/**
 * Decimal amount -> integer minor units, by string manipulation rather than
 * multiplication. `29.99 * 100` is 2998.9999999999995 in IEEE 754; this is not.
 */
export function toMinorUnits(amount: string | number, currencyCode: string): number {
  const exponent = currencyExponent(currencyCode);
  const text = typeof amount === 'number' ? amount.toFixed(exponent) : amount.trim();

  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`[money] not a decimal amount: ${amount}`);

  const [, sign, whole, fraction = ''] = match;

  // Keep `exponent` fraction digits, rounding on the first discarded one.
  const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
  const roundUp = (fraction[exponent] ?? '0') >= '5';

  const magnitude = Number(`${whole}${kept}`) + (roundUp ? 1 : 0);
  return sign === '-' ? -magnitude : magnitude;
}

/** Integer minor units -> MoneyV2. Null passes through: absent is not zero. */
export function toMoney(minorUnits: number | null, currencyCode: string): MoneyV2 | null {
  if (minorUnits === null) return null;

  const exponent = currencyExponent(currencyCode);
  const negative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits)).padStart(exponent + 1, '0');

  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;

  return { amount: `${negative ? '-' : ''}${whole}${fraction}`, currencyCode };
}
