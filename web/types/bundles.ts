/**
 * Bundle types for the E6 feature
 * Matches the backend DTO shape in src/routes/bundles.ts
 */

export type BundleOperation = 'merge' | 'expand' | 'update';

export type BundleStatus = 'Active' | 'Scheduled' | 'Ended' | 'Draft';

export interface BundleItem {
  variantId: string;
  qty: number;
  priceAdjustment?: number;
  titleOverride?: string;
  imageOverride?: string;
  /**
   * Per-unit price in dollars, used to build the `bundle.composition_v2`
   * metafield for `expand` bundles. Populated by the editor from the picked
   * variant; no DB migration needed — `items` is stored as free-form JSON.
   */
  price?: number;
}

export interface Bundle {
  id: string;
  name: string;
  operation: BundleOperation;
  items: BundleItem[];
  parentVariantId?: string;
  price: number | null;
  sumOfItems: number | null;
  status: BundleStatus;
  metafieldState: 'NotYet' | 'Written' | 'Cleared';
  metafieldGid?: string;
  updated: string;
}

export interface BundleSummary {
  count: number;
  inCampaigns: number;
  avgSaving: number;
}
