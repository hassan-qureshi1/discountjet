import type { Env } from '../types/env';
import { getShopAccessToken } from './getShopAccessToken';

const ADMIN_API_VERSION = '2026-04';

export interface GraphqlResult<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Runs a GraphQL query/mutation against a shop's Admin API using its stored
 * offline access token. Background-safe (webhooks, cron) — resolves and refreshes
 * the token via `getShopAccessToken`. Throws if no token is available or the HTTP
 * call fails; GraphQL-level errors are returned in the `errors` array.
 */
export async function adminGraphql<T = unknown>(
  shopDomain: string,
  env: Env,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  const accessToken = await getShopAccessToken(shopDomain, env);
  if (!accessToken) {
    throw new Error(`[adminGraphql] no access token for ${shopDomain}`);
  }

  const res = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  if (!res.ok) {
    throw new Error(`[adminGraphql] ${shopDomain} returned ${res.status} ${res.statusText}`);
  }

  return res.json<GraphqlResult<T>>();
}
