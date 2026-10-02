/**
 * What a sale pass should do to one bundle, decided without touching Shopify
 * or the database.
 *
 * Pure on purpose: this is the logic that can overwrite — and therefore lose —
 * a merchant's own price, so it is exhaustively testable with no mocks. The
 * caller performs the I/O; this only says what should happen.
 */
export interface SaleInputs {
  /** The bundle's sale price, in minor units. Null means none is set. */
  price: number | null;
  /** The merchant's compare-at override, minor units, or null for "use the sum". */
  compareAtPrice: number | null;
  /** The captured pre-sale price, minor units. Non-null means ON SALE NOW. */
  preSalePrice: number | null;
  /** Sum of the components' prices, minor units. */
  componentSumMinor: number;
}

export type SaleAction =
  | { kind: 'apply'; priceMinor: number; compareAtMinor: number; capturePreSaleFrom: 'live' }
  | { kind: 'restore'; priceMinor: number; compareAtMinor: number }
  | { kind: 'none'; reason: string };

/** The strikethrough is a standing property of a bundle, not of the sale. */
export function compareAtMinorFor(
  inputs: Pick<SaleInputs, 'compareAtPrice' | 'componentSumMinor'>,
): number {
  return inputs.compareAtPrice ?? inputs.componentSumMinor;
}

export function decideSaleAction(inputs: SaleInputs, shouldBeLive: boolean): SaleAction {
  const onSale = inputs.preSalePrice !== null;
  const compareAtMinor = compareAtMinorFor(inputs);

  if (shouldBeLive) {
    // Already on sale: doing nothing is not an optimisation, it is the
    // guarantee. Re-applying would capture the CURRENT (sale) price as the
    // pre-sale one and the merchant's real price would be unrecoverable.
    if (onSale) return { kind: 'none', reason: 'already on sale' };
    if (inputs.price === null) {
      return { kind: 'none', reason: 'bundle has no price to put on sale' };
    }
    return {
      kind: 'apply',
      priceMinor: inputs.price,
      compareAtMinor,
      capturePreSaleFrom: 'live',
    };
  }

  // Window closed. Restore is driven by the captured price alone — not by the
  // campaign, which may be gone, nor by the sale price, which may have been
  // cleared since.
  if (!onSale) return { kind: 'none', reason: 'not on sale' };
  return { kind: 'restore', priceMinor: inputs.preSalePrice as number, compareAtMinor };
}
