//
// Data layer for the E4 discount screens. Thin wrappers over apiFetch that
// hit the already-shipped Worker routes and return the prototype's response
// shapes. App Bridge auth is supplied by the caller (react-query hooks).
import { apiFetch, type AuthenticatedFetch } from '../api';
import type { Discount } from '../types/discounts';

export interface DiscountCounts {
  all: number;
  tier: number;
  bundle: number;
  special: number;
  inactive: number;
}

export interface DiscountsResponse {
  discounts: Discount[];
  counts: DiscountCounts;
}

export interface DiscountDetailResponse {
  discount: Discount;
  campaign: { id: string; name: string } | null;
}

export function fetchDiscounts(f: AuthenticatedFetch): Promise<DiscountsResponse> {
  return apiFetch<DiscountsResponse>(f, '/api/discounts');
}

export function fetchDiscount(f: AuthenticatedFetch, id: string): Promise<DiscountDetailResponse> {
  return apiFetch<DiscountDetailResponse>(f, `/api/discounts/${encodeURIComponent(id)}`);
}
