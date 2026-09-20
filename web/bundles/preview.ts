// web/bundles/preview.ts
//
// Pure arithmetic for BundleEditor's live "sum of items" preview, pulled out
// of the component so it can be unit tested without a DOM. Kept separate
// from web/lib/money.ts because it's bundle-specific (quantities), not a
// general money concern.

export interface PreviewItem {
  price: number | null;
  qty: number;
}

/**
 * Sums `price * qty` across the draft items for the live preview total.
 *
 * Returns `null` — never a number that silently treats an unknown price as
 * zero — the moment ANY item's price hasn't resolved yet. A total that
 * quietly omits a component is a wrong total, so the whole preview goes to
 * the em dash (via `formatMoney(null)`) rather than understating the sum.
 */
export function sumItemPrices(items: PreviewItem[]): number | null {
  if (items.some((it) => it.price == null)) return null;
  return items.reduce((sum, it) => sum + (it.price as number) * it.qty, 0);
}
