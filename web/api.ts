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

/**
 * A failed API call, carrying the merchant-facing text and the developer
 * detail in separate places.
 *
 * `message` is what a `Banner` shows, so it is the Worker's own merchant copy
 * and nothing else. The route and the status code are real debugging
 * information, but a merchant cannot act on either, and putting them in front
 * of one is a developer reading their own plumbing out loud. They live on the
 * instance instead, where the console and Bugsnag still report them.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Shown when the Worker fails without a message of its own — a 500 with an
 * empty body, a gateway serving HTML, a dropped connection. Deliberately says
 * nothing about what broke, because in these cases we do not know.
 */
const GENERIC_FAILURE = 'Something went wrong. Please try again.';

export async function apiFetch<T = unknown>(
  authenticatedFetch: AuthenticatedFetch,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const res = await authenticatedFetch(path, { ...init, headers });
  if (!res.ok) {
    // The Worker returns `{ error: "..." }` on every failure path, and that
    // message is written for the merchant — "This campaign's window has
    // already closed. Change the dates before publishing." It is the whole
    // message, not a detail appended to a status line.
    const detail = await res
      .clone()
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : ''))
      .catch(() => '');

    throw new ApiError(res.status, path, detail || GENERIC_FAILURE);
  }
  return res.json() as Promise<T>;
}
