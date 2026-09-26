/**
 * Money helpers. All money in D1 is stored as integer MINOR UNITS — deliberately
 * not called "cents", because the number of minor units in a major unit depends
 * on the currency: JPY and KRW have 0, most currencies 2, KWD and BHD have 3.
 */

/** Shopify's MoneyV2 shape — an exact decimal string plus its currency. */
export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

/**
 * ISO 4217 currencies whose minor unit is NOT the usual 1/100.
 *
 * This is deliberately a table and NOT `Intl.NumberFormat(...).resolvedOptions()`.
 * Intl reports CLDR *display* digits, which are a presentation choice, differ
 * between ICU builds, and change between CLDR releases. The Worker runtime, Node
 * and the browser therefore do not agree: workerd resolves PKR to 0 digits while
 * Node resolves it to 2. Deriving the exponent independently on each side let the
 * same amount be stored as 32 on the server and read as 0.32 in the browser —
 * every value off by a factor of a hundred, silently.
 *
 * The number of minor units in a currency is a property of the currency, not of
 * whoever is rendering it, so it is pinned here. Shopify prices PKR with two
 * decimals, matching ISO 4217 rather than CLDR display digits.
 */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Minor units per major unit, as a power of ten. AUD -> 2, JPY -> 0, KWD -> 3. */
export function currencyExponent(currencyCode: string): number {
  if (!CURRENCY_CODE.test(currencyCode)) {
    // A shop row with a bad or missing currency is a data-integrity problem.
    // Guessing 2 would silently store JPY off by a factor of 100.
    throw new Error(`[money] unknown currency code: ${currencyCode}`);
  }
  if (ZERO_DECIMAL.has(currencyCode)) return 0;
  if (THREE_DECIMAL.has(currencyCode)) return 3;
  return 2;
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
