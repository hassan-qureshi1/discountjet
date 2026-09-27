// web/templates/api.ts
//
// Data layer for the promotion template gallery + create flow. Thin wrappers
// over apiFetch that hit the Worker's template + discount routes
// (src/routes/templates.ts, src/routes/discounts.ts). App Bridge auth is
// supplied by the caller (react-query hooks). Mirrors web/bundles/api.ts.
import { apiFetch, type AuthenticatedFetch } from '../api';

export type DiscountEngineType = 'tier' | 'bundle' | 'special';

export interface Template {
  slug: string;
  name: string;
  description: string;
  example: string | null;
  category: string;
  symbol: string | null;
  type: DiscountEngineType;
  /** Partial form data for the engine named by `type`. Arrives already
   * parsed — the server never sends this as a JSON string. */
  defaults: Record<string, unknown>;
}

export interface CreateDiscountInput {
  slug: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
  form: unknown;
}

export function fetchTemplates(f: AuthenticatedFetch): Promise<{ templates: Template[] }> {
  return apiFetch<{ templates: Template[] }>(f, '/api/templates');
}

export function fetchTemplate(f: AuthenticatedFetch, slug: string): Promise<{ template: Template }> {
  return apiFetch<{ template: Template }>(f, `/api/templates/${encodeURIComponent(slug)}`);
}

export function createDiscountFromTemplate(
  f: AuthenticatedFetch,
  input: CreateDiscountInput,
): Promise<{ discountId: string }> {
  return apiFetch<{ discountId: string }>(f, '/api/discounts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
