/**
 * Minimal API helper for the starter.
 *
 * Usage (App Bridge 4 — do NOT use the v3 `authenticatedFetch` utility, it
 * calls app.subscribe() which doesn't exist on the v4 useAppBridge() object):
 *   import { useAppBridge } from '@shopify/app-bridge-react';
 *   import { apiFetch, createAuthenticatedFetch } from './api';
 *
 *   const shopify = useAppBridge();
 *   const fetcher = createAuthenticatedFetch(shopify);
 *   const data = await apiFetch<ExampleResponse>(fetcher, '/api/example');
 *
 * `createAuthenticatedFetch` attaches the App Bridge 4 ID token as a Bearer
 * header; the Worker's `requireShop` middleware verifies the JWT.
 */
export type AuthenticatedFetch = (
  uri: string,
  options?: RequestInit,
) => Promise<Response>;

type AppBridgeIdToken = {
  idToken: () => Promise<string>;
};

export function createAuthenticatedFetch(
  appBridge: AppBridgeIdToken,
  fetchImpl: typeof fetch = fetch,
): AuthenticatedFetch {
  return async (uri, options = {}) => {
    const token = await appBridge.idToken();
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);

    return fetchImpl(uri, { ...options, headers });
  };
}

export async function apiFetch<T = unknown>(
  authenticatedFetch: AuthenticatedFetch,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const res = await authenticatedFetch(path, { ...init, headers });
  if (!res.ok) {
    // The Worker returns `{ error: "..." }` on every failure path, and that
    // message is usually the only place the underlying cause appears (a
    // Shopify userError behind a 502, say). Dropping it left the UI showing a
    // bare status code with nothing to act on. The `failed: <status>` prefix
    // is preserved — 404 detection in the detail pages matches on it.
    const detail = await res
      .clone()
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : ''))
      .catch(() => '');

    throw new Error(
      `Request to ${path} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return res.json() as Promise<T>;
}
