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

export interface BundleInput {
  name: string;
  operation: BundleOperation;
  items: BundleItem[];
  parentVariantId?: string;
  price?: number;
  sumOfItems?: number;
  status?: BundleStatus;
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

export function fetchBundleAdminUrl(f: AuthenticatedFetch, id: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(f, `/api/bundles/${encodeURIComponent(id)}/admin-url`);
}
