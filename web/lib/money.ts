/** Shopify's MoneyV2 shape, as the bundles API sends it. */
export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

/**
 * The one money formatter. Replaces the two hardcoded `$`/`en-US` helpers that
 * used to live in Bundles.tsx and BundleEditor.tsx — those rendered a JPY
 * amount as "¥1,000.00", which is both the wrong symbol and the wrong number
 * of decimals.
 */
export function formatMoney(money: MoneyV2 | null, locale = 'en'): string {
  if (!money) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currencyCode,
  }).format(Number(money.amount));
}

/**
 * The shop currency's symbol, for a money INPUT's prefix — a `TextField` has no
 * amount to format yet, so `formatMoney` cannot supply it.
 *
 * Returns `undefined` when the currency is unknown, so the field renders with
 * NO prefix rather than a guessed `$`. That mirrors the read paths, which show
 * the em dash instead of inventing a currency; a hardcoded `$` on an AUD or JPY
 * shop is exactly what this change set removes.
 */
export function currencySymbol(currencyCode: string | undefined): string | undefined {
  if (currencyCode === undefined) return undefined;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value;
  } catch {
    // An unknown/invalid code is a data problem, not a reason to guess a symbol.
    return undefined;
  }
}

/** The numeric amount, for arithmetic like the savings column. Null stays null. */
export function moneyAmount(money: MoneyV2 | null): number | null {
  return money === null ? null : Number(money.amount);
}
