// web/types/discounts.ts
//
// Domain types for the E4 discount screens. These mirror the response shapes
// the Worker already emits (src/routes/discounts.ts, src/routes/shopifyDiscounts.ts),
// ported from the discount-engine-ui prototype so the pages render unchanged.

export type Tone = 'success' | 'info' | 'warning' | 'critical' | 'magic' | 'neutral';

// ─── App-owned discounts (GET /api/discounts, GET /api/discounts/:id) ─────────
export type DiscountType = 'Tier' | 'Bundle' | 'Special';
export type DiscountStatus = 'Active' | 'Inactive';

export interface Discount {
  id: string;
  name: string;
  symbol: string;
  type: DiscountType;
  status: DiscountStatus;
  products: number;
  updated: string;
  campaignId?: string;
}

export const DISCOUNT_TYPE_LABEL: Record<DiscountType, string> = {
  Tier: 'Volume discount',
  Bundle: 'Buy X, get Y',
  Special: 'Buy X, discount both',
};

// ─── Native + app discounts (GET /api/shopify-discounts) ──────────────────────
export type ShopifyDiscountStatus = 'Active' | 'Scheduled' | 'Expired';
export type DiscountEngineKind = 'Tier' | 'Bundle' | 'Split';

export interface ShopifyDiscount {
  id: string;
  title: string;
  status: ShopifyDiscountStatus;
  method: 'Automatic' | 'Code';
  type: string;
  /** Set when this row is a Discount Engine app discount (vs a native Shopify one). */
  engine: DiscountEngineKind | null;
  /** Links a Discount Engine row to its app Discount (opens its detail). */
  appId?: string;
  used: number;
}
