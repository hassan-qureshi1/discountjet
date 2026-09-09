/**
 * Bundle operations gating and metadata
 * Corrected from the prototype: only `update` is gated by Shopify Plus,
 * `merge` and `expand` are always enabled. No app-tier concept.
 */

import type { BundleOperation } from '../types/bundles';

export interface OperationMeta {
  id: BundleOperation;
  label: string;
  description: string;
}

/**
 * Cart-transform operations (from shopify.dev/docs/api/functions/cart-transform)
 * Descriptions ported from the prototype.
 */
export const OPERATIONS: OperationMeta[] = [
  {
    id: 'merge',
    label: 'Merge',
    description: 'Combine multiple cart lines into a single bundle line, with an overridden price.',
  },
  {
    id: 'expand',
    label: 'Expand',
    description: "Expand one cart line into its bundled component lines (max 2000 per line).",
  },
  {
    id: 'update',
    label: 'Update',
    description: "Override a line's price, title, or image in the cart.",
  },
];

export const getOp = (id: BundleOperation): OperationMeta => {
  const op = OPERATIONS.find((o) => o.id === id);
  if (!op) throw new Error(`Unknown operation: ${id}`);
  return op;
};

export interface GateResult {
  enabled: boolean;
  reason?: string;
}

/**
 * Gate operation based on the operation type and whether the store is Shopify Plus eligible.
 *
 * - `merge` and `expand` are always enabled.
 * - `update` requires Shopify Plus (updateOpEligible = true).
 */
export function gateOperation(op: BundleOperation, updateOpEligible: boolean): GateResult {
  if (op === 'merge' || op === 'expand') {
    return { enabled: true };
  }

  if (op === 'update') {
    return updateOpEligible
      ? { enabled: true }
      : { enabled: false, reason: 'Requires Shopify Plus' };
  }

  return { enabled: false, reason: `Unknown operation: ${op}` };
}

/**
 * Real Shopify cart-transform limits, surfaced to the merchant.
 * Ported from the prototype.
 */
export const CART_TRANSFORM_LIMITS = [
  'A store can run only one cart transform at a time.',
  'Expanded items are capped at 2000 per cart line.',
  'Overriding price, title, or image (Update) requires Shopify Plus.',
  'Cart transforms are skipped when a subscription (selling plan) is in the cart.',
];

export const MAX_EXPAND_QTY = 2000;
