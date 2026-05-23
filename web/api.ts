/**
 * Minimal API helper for the starter.
 *
 * Usage:
 *   import { useAppBridge } from '@shopify/app-bridge-react';
 *   import { authenticatedFetch } from '@shopify/app-bridge/utilities';
 *   import { apiFetch } from './api';
 *
 *   const app = useAppBridge();
 *   const fetcher = authenticatedFetch(app);
 *   const data = await apiFetch<ExampleResponse>(fetcher, '/api/example');
 *
 * `authenticatedFetch` attaches the Shopify session token (JWT) to every
 * request, which the Worker's `requireShop` middleware verifies.
 */
export type AuthenticatedFetch = (
  uri: string,
  options?: RequestInit,
) => Promise<Response>;

export async function apiFetch<T = unknown>(
  authenticatedFetch: AuthenticatedFetch,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const res = await authenticatedFetch(path, { ...init, headers });
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
