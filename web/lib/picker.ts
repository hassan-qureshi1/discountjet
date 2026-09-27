// web/lib/picker.ts
//
// Pure helpers for the App Bridge PRODUCT resource picker (the grouped
// "Select products" dialog, where variants are checkboxes nested under their
// product) — as opposed to the flat variant picker. Kept out of the editor
// component so the mapping between picker payloads and bundle items is
// unit-testable without rendering anything. Lives here (not under
// web/bundles/) because it's about Shopify's resource picker, not bundles —
// the tier form needs it too.
import type { ResolvedVariant } from '../bundles/api';

/** The slice of App Bridge's `Product`/`ProductVariant` payloads this module
 * reads. Declared structurally rather than importing the full App Bridge types
 * so the tests can build fixtures without inventing ~30 irrelevant fields. */
export interface PickedVariant {
  id?: string;
  title?: string;
  displayName?: string;
  price?: string;
}

export interface PickedProduct {
  id?: string;
  title?: string;
  variants?: PickedVariant[];
}

export interface PickedItem {
  variantId: string;
  /** Per-unit price in dollars. Undefined when the picker didn't supply one —
   * never NaN, which would poison the "sum of items" total downstream. */
  price?: number;
  /** Display label for this session, until the page-load resolver supplies the
   * canonical product/variant names. */
  title: string;
}

/** Shopify's placeholder title for a product with no real variant options. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * Flattens a product-picker payload into one entry per selected variant.
 *
 * The picker returns products, each carrying only the variants the merchant
 * checked (checking the product row yields all of them), so the bundle's flat
 * item list is this flatMap. Order follows the picker's own ordering.
 */
export function flattenPickerSelection(products: PickedProduct[]): PickedItem[] {
  return products.flatMap((product) => (product.variants ?? []).flatMap((variant) => {
    // A variant with no id can't be stored or written to a metafield; dropping
    // it is better than persisting a half-item that fails later at checkout.
    if (!variant.id) return [];

    const price = variant.price != null ? Number(variant.price) : NaN;
    const productTitle = product.title ?? '';
    const variantTitle = variant.title && variant.title !== DEFAULT_VARIANT_TITLE
      ? variant.title
      : undefined;

    const title = variant.displayName
      ?? [productTitle, variantTitle].filter(Boolean).join(' - ');

    return [{
      variantId: variant.id,
      ...(Number.isFinite(price) ? { price } : {}),
      title: title || variant.id,
    }];
  }));
}

/**
 * `gid://shopify/ProductVariant/123` -> `123`.
 *
 * TWO CONVENTIONS MEET HERE, and they disagree. The App Bridge picker returns
 * GIDs. The cart-transform bundle metafield also wants GIDs (see
 * `toVariantGid` in `src/lib/bundleMetafields.ts`). But the DISCOUNT engines'
 * `targets` are documented as "numeric IDs only" and run every id through
 * `Number(...)`, which yields NaN for a GID and silently drops it — taking the
 * whole tier with it, since a tier with no resolvable ids is skipped entirely.
 *
 * Mirrors `numericId` in `extensions/discount-tier-ui/src/TierCard.tsx`, which
 * is the convention the deployed extension already stores. Going the other way
 * (numeric id -> GID, to pre-check the picker) is that file's line 73.
 *
 * Idempotent: an already-numeric id passes through, so it is safe to re-apply.
 */
export function toNumericId(gid: string): string {
  return gid.split('/').pop() ?? '';
}

export interface SelectionIds {
  /** `selectionIds` for `resourcePicker({ type: 'product' })` — variants are
   * pre-checked under their owning product. */
  selectionIds: { id: string; variants: { id: string }[] }[];
  /**
   * False when at least one variant couldn't be placed under a product (names
   * still loading, lookup failed, or the variant was deleted in Shopify). The
   * caller must then MERGE the picker result into the existing items instead
   * of replacing them — replacing on a partial pre-selection would silently
   * drop the items the picker couldn't show as checked.
   */
  complete: boolean;
}

/**
 * Groups variant gids under their owning product gid, which is the shape the
 * product picker wants for pre-selection. Product ids come from the page-load
 * variant resolver (`GET /api/variants`); the app itself stores only variant
 * ids.
 */
export function selectionIdsFromVariants(
  variantIds: string[],
  resolved: Map<string, ResolvedVariant>,
): SelectionIds {
  const byProduct = variantIds.reduce<Map<string, { id: string }[]>>((acc, variantId) => {
    const productId = resolved.get(variantId)?.productId;
    if (productId) acc.set(productId, [...(acc.get(productId) ?? []), { id: variantId }]);
    return acc;
  }, new Map());

  return {
    selectionIds: [...byProduct].map(([id, variants]) => ({ id, variants })),
    complete: variantIds.every((variantId) => Boolean(resolved.get(variantId)?.productId)),
  };
}
