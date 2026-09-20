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

/** The numeric amount, for arithmetic like the savings column. Null stays null. */
export function moneyAmount(money: MoneyV2 | null): number | null {
  return money === null ? null : Number(money.amount);
}
