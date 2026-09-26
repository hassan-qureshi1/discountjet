/**
 * Bundle types for the E6 feature
 * Matches the backend DTO shape in src/routes/bundles.ts
 */
import type { MoneyV2 } from '../lib/money';

export type { MoneyV2 };

export type BundleOperation = 'merge' | 'expand' | 'update';

export type BundleStatus = 'Active' | 'Scheduled' | 'Ended' | 'Draft';

export interface BundleItem {
  variantId: string;
  name: string;
  qty: number;
  price: MoneyV2;
  priceAdjustment?: MoneyV2;
  titleOverride?: string;
}

export interface Bundle {
  id: string;
  name: string;
  operation: BundleOperation;
  items: BundleItem[];
  parentVariantId?: string;
  price: MoneyV2 | null;
  sumOfItems: MoneyV2 | null;
  status: BundleStatus;
  metafieldState: 'NotYet' | 'Written' | 'Cleared';
  metafieldGid?: string;
  updated: string;
}

export interface BundleSummary {
  count: number;
  inCampaigns: number;
  avgSaving: MoneyV2 | null;
}
