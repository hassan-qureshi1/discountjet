// ─── Shared domain types for the Discount Engine UI ──────────────────────────
// Every hardcoded fixture in src/data/*.json is typed against these interfaces
// and hydrated into the Zustand store (src/store/useDiscountStore.ts).

/** Polaris Badge tones we use across the app. 'neutral' means "no tone". */
export type Tone = 'success' | 'info' | 'warning' | 'critical' | 'magic' | 'neutral';

export interface Shop {
  name: string;
  initials: string;
  /** Our app's plan tier (Starter / Growth / Scale). */
  plan: string;
  /** The store's Shopify plan (e.g. Basic, Shopify, Advanced, Plus). */
  shopifyPlan: string;
}

// ─── Overview ────────────────────────────────────────────────────────────────
export interface StatBadge {
  tone: Tone;
  label: string;
}

export interface OverviewStat {
  label: string;
  value: string;
  detail?: string;
  badges?: StatBadge[];
  /** Renders the value in the success colour (e.g. "Healthy"). */
  positive?: boolean;
}

export interface ActivityItem {
  symbol: string;
  tone: Tone;
  title: string;
  action: string;
  meta: string;
  time: string;
}

export interface CartScheduleItem {
  symbol: string;
  tone: Tone;
  title: string;
  detail: string;
  status: string;
}

export interface OverviewData {
  banner: { title: string; description: string };
  stats: OverviewStat[];
  recentActivity: ActivityItem[];
  cartSchedule: CartScheduleItem[];
}

// ─── Discounts ───────────────────────────────────────────────────────────────
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
  /** Set when this discount was created by (and is owned/locked to) a campaign. */
  campaignId?: string;
}

/** Merchant-facing label for each discount type (engine name kept internally). */
export const DISCOUNT_TYPE_LABEL: Record<DiscountType, string> = {
  Tier: 'Volume discount',
  Bundle: 'Buy X, get Y',
  Special: 'Buy X, discount both',
};

// ─── Bundles (cart-transform bundles; type name kept for store compatibility) ─
export type CartTransformStatus = 'Active' | 'Scheduled' | 'Ended';

/** The Shopify cart-transform operation a bundle uses. */
export type CartTransformOp = 'merge' | 'expand' | 'update';

// ─── Bundle campaigns ────────────────────────────────────────────────────────
export type BundleCampaignStatus = 'Draft' | 'Scheduled' | 'Active' | 'Ended';

/** A bundle included in a campaign, with its scheduled price override. */
export interface BundleCampaignBundle {
  bundleId: string;
  price: number;
  compareAtPrice: number;
}

export interface BundleCampaign {
  id: string;
  name: string;
  status: BundleCampaignStatus;
  starts: string;
  ends: string;
  bundles: BundleCampaignBundle[];
}

export interface CartTransform {
  id: string;
  name: string;
  /** Which Shopify cart-transform operation this bundle performs. */
  operation: CartTransformOp;
  /** Variant/product names that make up the bundle. */
  items: string[];
  /** Bundle price the shopper pays. */
  price: number;
  /** Sum of the items' individual prices (used to show the saving). */
  sumOfItems: number;
  schedule: string;
  status: CartTransformStatus;
  metafield: string;
  updated: string;
}

// ─── Campaigns ───────────────────────────────────────────────────────────────
export type CampaignStatus = 'Draft' | 'Scheduled' | 'Published' | 'Ended';

export interface Campaign {
  id: string;
  name: string;
  detail: string;
  discounts: number;
  bundles: number;
  revenue: number | null;
  orders: number | null;
  discount: number | null;
  schedule: string;
  status: CampaignStatus;
  live?: boolean;
}

// ─── Templates ───────────────────────────────────────────────────────────────
export interface Template {
  id: string;
  emoji: string;
  name: string;
  description: string;
  example: string;
  category: string;
}

/** A ready-made campaign preset shown on the "Campaign templates" screen. */
export interface CampaignTemplate {
  id: string;
  emoji: string;
  name: string;
  description: string;
  example: string;
  category: string;
}

// ─── Shopify (native) discounts list ─────────────────────────────────────────
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

// ─── Plan & limits ───────────────────────────────────────────────────────────
export interface PlanTier {
  name: string;
  limit: number;
  current: boolean;
}

export interface PlanData {
  banner: { title: string; description: string };
  current: string;
  used: number;
  limit: number;
  usagePercent: number;
  tiers: PlanTier[];
}
