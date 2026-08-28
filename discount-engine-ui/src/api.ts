// Minimal API client for the Discount Engine UI.
//
// In the embedded admin, App Bridge exposes `window.shopify.idToken()`; we attach
// it as a Bearer token so the Worker's `requireShop` middleware can authenticate
// the request. Outside the embed (pure local dev) the call falls back to an
// unauthenticated fetch, which the Worker accepts only via its dev shop-param path.
import type { Discount } from './types';

interface AppBridgeGlobal {
  idToken?: () => Promise<string>;
}
declare global {
  interface Window {
    shopify?: AppBridgeGlobal;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = await window.shopify?.idToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // No App Bridge token available (local dev) — send unauthenticated.
  }
  return headers;
}

export interface DiscountsResponse {
  discounts: Discount[];
  counts: { all: number; tier: number; bundle: number; special: number; inactive: number };
}

export async function fetchDiscounts(): Promise<DiscountsResponse> {
  const res = await fetch('/api/discounts', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`GET /api/discounts failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<DiscountsResponse>;
}
