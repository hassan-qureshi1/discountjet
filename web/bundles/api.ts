// web/bundles/api.ts
//
// Data layer for the E6 bundle screens. Thin wrappers over apiFetch that hit
// the Worker's bundle routes (src/routes/bundles.ts) and shop-plan route
// (src/routes/shop.ts). App Bridge auth is supplied by the caller (react-query
// hooks). Mirrors web/discounts/api.ts.
import { apiFetch, type AuthenticatedFetch } from '../api';
import type {
  Bundle, BundleItem, BundleOperation, BundleStatus, BundleSummary,
} from '../types/bundles';

export type {
  Bundle, BundleItem, BundleOperation, BundleStatus, BundleSummary,
};

/**
 * The shape of an item as sent to the server. Deliberately NOT `BundleItem`
 * (the wire-read shape) — the server re-resolves `name` and `price` from
 * Shopify on every save and ignores whatever the client sends, so those
 * fields have no business being in the request body.
 */
export interface BundleItemInput {
  variantId: string;
  qty: number;
  priceAdjustment?: number;
  titleOverride?: string;
}

export interface BundleInput {
  name: string;
  operation: BundleOperation;
  items: BundleItemInput[];
  parentVariantId?: string;
  price?: number;
  /** Major units. A number sets it, an explicit `null` clears it back to "use
   * the component sum", and an absent key leaves the stored value untouched. */
  compareAtPrice?: number | null;
  status?: BundleStatus;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
}

export interface BundlesResponse {
  bundles: Bundle[];
  summary: BundleSummary;
}

export interface BundleDetailResponse {
  bundle: Bundle;
}

export interface ShopPlanResponse {
  updateOpEligible: boolean;
  planName: string | null;
  currencyCode: string;
}

export function fetchBundles(f: AuthenticatedFetch): Promise<BundlesResponse> {
  return apiFetch<BundlesResponse>(f, '/api/bundles');
}

export function fetchBundle(f: AuthenticatedFetch, id: string): Promise<BundleDetailResponse> {
  return apiFetch<BundleDetailResponse>(f, `/api/bundles/${encodeURIComponent(id)}`);
}

export function createBundle(f: AuthenticatedFetch, input: BundleInput): Promise<BundleDetailResponse> {
  return apiFetch<BundleDetailResponse>(f, '/api/bundles', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateBundle(
  f: AuthenticatedFetch,
  id: string,
  input: Partial<BundleInput>,
): Promise<BundleDetailResponse> {
  return apiFetch<BundleDetailResponse>(f, `/api/bundles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteBundle(f: AuthenticatedFetch, id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(f, `/api/bundles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function fetchShopPlan(f: AuthenticatedFetch): Promise<ShopPlanResponse> {
  return apiFetch<ShopPlanResponse>(f, '/api/shop/plan');
}

/**
 * One entry per requested variant gid, in the order requested. `exists:false`
 * means the variant (or its product) no longer resolves in Shopify — the
 * editor renders those as "no longer exists" rather than a silent blank.
 */
export interface ResolvedVariant {
  id: string;
  exists: boolean;
  /** Owning product gid, used to pre-select the product resource picker. */
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  adminUrl?: string;
  /** The product's live storefront page. Absent when the product isn't
   * published to the Online Store, in which case there is no page to link to
   * and the storefront link is omitted rather than rendered dead. */
  storefrontUrl?: string;
  /** The variant's own image, falling back to the product's featured image.
   * Absent when the product has no imagery at all. */
  imageUrl?: string;
  imageAlt?: string;
  /** Per-unit price as an exact decimal string in the shop's currency.
   * Already sent by `GET /api/variants`, which returns the resolved
   * variant whole; this type simply never declared it. */
  price?: string;
}

export interface VariantsResponse {
  variants: ResolvedVariant[];
}

/**
 * Resolves product + variant names and admin deep links for a set of variant
 * gids in ONE request. Names are never persisted app-side — they're resolved
 * on page load so a rename in Shopify shows up immediately.
 */
export function fetchVariants(f: AuthenticatedFetch, ids: string[]): Promise<VariantsResponse> {
  // No ids means nothing to ask Shopify about; skip the round trip entirely
  // (a `/bundles/new` page with no variants picked yet hits this path).
  if (ids.length === 0) return Promise.resolve({ variants: [] });
  return apiFetch<VariantsResponse>(f, `/api/variants?ids=${encodeURIComponent(ids.join(','))}`);
}

export function fetchBundleAdminUrl(f: AuthenticatedFetch, id: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(f, `/api/bundles/${encodeURIComponent(id)}/admin-url`);
}

export interface ActivationMetafieldStatus {
  mergeBundlesValuePresent: boolean;
}

export interface ActivationResponse {
  active: boolean;
  conflict?: boolean;
  error?: string;
  metafields?: ActivationMetafieldStatus;
}

/**
 * Triggers the Worker's `ensureCartTransform` side effect (registers/adopts
 * the store's cart-transform slot). This endpoint can return a 500 with a
 * meaningful JSON body (`{ active: false, error }`) so, unlike the other
 * calls above, we read the JSON regardless of status instead of using
 * apiFetch (which throws on non-2xx). Only a network/parse failure throws.
 */
export async function fetchActivation(f: AuthenticatedFetch): Promise<ActivationResponse> {
  const res = await f('/api/bundles/activation');
  return res.json() as Promise<ActivationResponse>;
}
