import type { CartTransformOp } from '../../types';

// ─── App plan tiers ──────────────────────────────────────────────────────────
export type AppTier = 'Starter' | 'Growth' | 'Scale';
const TIER_ORDER: AppTier[] = ['Starter', 'Growth', 'Scale'];
export const tierAtLeast = (current: AppTier, min: AppTier) =>
  TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(min);

// ─── Cart-transform operations (from shopify.dev/docs/api/functions/cart-transform)
export interface OpMeta {
  id: CartTransformOp;
  label: string;
  description: string;
  /** Minimum app tier that unlocks this operation. */
  minTier: AppTier;
  /** Shopify only allows lineUpdate on dev stores or Shopify Plus. */
  requiresPlus: boolean;
}

export const OPERATIONS: OpMeta[] = [
  {
    id: 'merge',
    label: 'Merge',
    description: 'Combine multiple cart lines into a single bundle line, with an overridden price.',
    minTier: 'Starter',
    requiresPlus: false,
  },
  {
    id: 'expand',
    label: 'Expand',
    description: 'Expand one cart line into its bundled component lines (max 2000 per line).',
    minTier: 'Growth',
    requiresPlus: false,
  },
  {
    id: 'update',
    label: 'Update',
    description: 'Override a line’s price, title, or image in the cart.',
    minTier: 'Scale',
    requiresPlus: true,
  },
];

export const getOp = (id: CartTransformOp) => OPERATIONS.find((o) => o.id === id)!;

export interface GateResult {
  enabled: boolean;
  /** Human-readable reasons the capability is locked (e.g. "Upgrade to Scale"). */
  reasons: string[];
}

/** Combined gate: app tier AND (for update) the Shopify plan. */
export function gateOperation(op: OpMeta, appTier: AppTier, shopifyPlus: boolean): GateResult {
  const reasons: string[] = [];
  if (!tierAtLeast(appTier, op.minTier)) reasons.push(`Upgrade to ${op.minTier}`);
  if (op.requiresPlus && !shopifyPlus) reasons.push('Requires Shopify Plus');
  return { enabled: reasons.length === 0, reasons };
}

/** Field-level gate — advanced fields (title/image override, per-component pricing) need Scale. */
export function gateField(minTier: AppTier, appTier: AppTier): GateResult {
  return tierAtLeast(appTier, minTier)
    ? { enabled: true, reasons: [] }
    : { enabled: false, reasons: [`Upgrade to ${minTier}`] };
}

/** Real Shopify cart-transform limits, surfaced to the merchant. */
export const CART_TRANSFORM_LIMITS = [
  'A store can run only one cart transform at a time.',
  'Expanded items are capped at 2000 per cart line.',
  'Overriding price, title, or image (Update) requires Shopify Plus.',
  'Cart transforms are skipped when a subscription (selling plan) is in the cart.',
];

export const MAX_EXPAND_QTY = 2000;
