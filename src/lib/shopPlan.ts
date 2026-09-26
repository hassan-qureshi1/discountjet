/**
 * Whether a shop's plan permits the `update` (lineUpdate) cart-transform
 * operation.
 *
 * Read from the plan NAME Shopify gives us and stored verbatim, rather than
 * from the `shopify_plus` boolean. That boolean is true for partner
 * development stores as well, and Shopify's own rule is indeed broader —
 * "development stores or stores on a Shopify Plus plan". Gating on the plan
 * name keeps the stored value faithful to what Shopify reports while letting
 * the app be stricter than the platform.
 *
 * Plus stores report a display name containing "Plus" ("Shopify Plus"). Every
 * other tier — Basic, Shopify, Advanced, Developer Preview — does not.
 */
export function isPlusPlan(plan: string | null | undefined): boolean {
  if (!plan) return false;
  return plan.toLowerCase().includes('plus');
}

/** The reason shown wherever the `update` operation is refused. */
export function planGateReason(plan: string | null | undefined): string {
  return plan
    ? `Requires Shopify Plus — this store is on ${plan}.`
    : 'Requires Shopify Plus.';
}
