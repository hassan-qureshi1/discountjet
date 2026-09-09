// web/types/discounts.ts
//
// Domain types for the E4 discount screens. These mirror the response shapes
// the Worker already emits (src/routes/discounts.ts), ported from the
// discount-engine-ui prototype so the pages render unchanged.

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

// ─── Discount engine kinds (used by the discount-type picker) ─────────────────
export type DiscountEngineKind = 'Tier' | 'Bundle' | 'Split';
