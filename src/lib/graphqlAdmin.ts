import type { Env } from '../types/env';
import { getShopAccessToken } from './getShopAccessToken';

const ADMIN_API_VERSION = '2026-04';

/**
 * How long to wait on the Admin API before giving up.
 *
 * `fetch` has no default timeout, so a Shopify call that never settles takes
 * the whole request with it: the Worker stops responding, and the platform
 * returns a body-less 502 the client cannot explain and the server never logs.
 * That failure is indistinguishable from a dozen others and leaves nothing to
 * act on. Ten seconds is far beyond a healthy Admin response and well inside
 * the time a merchant will wait, so a hang becomes a message instead.
 */
const ADMIN_TIMEOUT_MS = 10_000;

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

  let res: Response;
  try {
    res = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
  } catch (err) {
    // Name the timeout explicitly. "The operation was aborted" says nothing
    // about which call stalled or against which shop, and this message is the
    // only thing that reaches the merchant.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(
        `[adminGraphql] ${shopDomain} did not respond within ${ADMIN_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    throw new Error(`[adminGraphql] ${shopDomain} returned ${res.status} ${res.statusText}`);
  }

  return res.json<GraphqlResult<T>>();
}
