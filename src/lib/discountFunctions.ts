import { adminGraphql } from './graphqlAdmin';
import type { Env } from '../types/env';

interface ShopifyFunctionsQueryResult {
  shopifyFunctions: {
    nodes: Array<{ id: string; handle: string; title: string; apiType: string }>;
  };
}

const SHOPIFY_FUNCTIONS_QUERY = /* GraphQL */ `
  query DiscountFunctions {
    shopifyFunctions(first: 50) {
      nodes {
        id
        handle
        title
        apiType
      }
    }
  }
`;

/**
 * Turn an extension handle (`discount-tier`) into the `functionId` that
 * `discountAutomaticAppCreate` requires on Admin API 2026-04.
 *
 * Matches on `handle`, NOT on `title`. The display names are merchant-facing
 * copy and have already been renamed once in this repo
 * ("chore(discount-fns): rename function display names to merchant language");
 * the handle is the extension's identity and does not move.
 *
 * Deliberately NOT cached. A stale Shopify id that nothing re-verifies is the
 * bug fixed in 21a0d3a, where a cached `cartTransformGid` left the app
 * permanently believing a transform was registered while checkout had none. One
 * extra Admin call per create is cheap; a permanently wrong id is not.
 */
export async function resolveDiscountFunctionId(
  env: Env,
  shopDomain: string,
  handle: string,
): Promise<string> {
  const res = await adminGraphql<ShopifyFunctionsQueryResult>(shopDomain, env, SHOPIFY_FUNCTIONS_QUERY);

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[discountFunctions] GraphQL errors resolving shopifyFunctions for ${shopDomain}: ${JSON.stringify(res.errors)}`,
    );
  }

  const match = (res.data?.shopifyFunctions?.nodes ?? []).find((node) => node.handle === handle);
  if (!match) {
    // No fallback to "the first discount function" — that would create a
    // discount priced by an engine the merchant never chose.
    throw new Error(`[discountFunctions] function '${handle}' is not deployed for ${shopDomain}`);
  }
  return match.id;
}
