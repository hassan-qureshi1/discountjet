import type { Env } from '../types/env';
import type { Db } from '../db/db';
import type { IShopRepository } from '../db/repositories';
import { adminGraphql } from './graphqlAdmin';

const CART_TRANSFORM_API_TYPE = 'cart_transform';
const CART_TRANSFORMER_TITLE_HINT = /cart[-\s]?transformer/i;

interface ShopifyFunctionsQueryResult {
  shopifyFunctions: {
    nodes: Array<{ id: string; title: string; apiType: string }>;
  };
}

const SHOPIFY_FUNCTIONS_QUERY = /* GraphQL */ `
  query ShopifyFunctions {
    shopifyFunctions(first: 50) {
      nodes {
        id
        title
        apiType
      }
    }
  }
`;

interface CartTransformsQueryResult {
  cartTransforms: {
    nodes: Array<{ id: string; functionId: string }>;
  };
}

const CART_TRANSFORMS_QUERY = /* GraphQL */ `
  query CartTransforms {
    cartTransforms(first: 10) {
      nodes {
        id
        functionId
      }
    }
  }
`;

interface CartTransformCreateResult {
  cartTransformCreate: {
    cartTransform: { id: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

const CART_TRANSFORM_CREATE_MUTATION = /* GraphQL */ `
  mutation CartTransformCreate($functionId: String!) {
    cartTransformCreate(functionId: $functionId, blockOnFailure: false) {
      cartTransform {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Resolves the deployed cart-transform function's id via
 * `shopifyFunctions(apiType: cart_transform)`. Throws loudly if the
 * cart-transformer extension hasn't been deployed to this shop — that's a
 * hard prerequisite, not something to silently skip past.
 */
async function resolveCartTransformFunctionId(env: Env, shopDomain: string): Promise<string> {
  const res = await adminGraphql<ShopifyFunctionsQueryResult>(shopDomain, env, SHOPIFY_FUNCTIONS_QUERY);

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[ensureCartTransform] GraphQL errors resolving shopifyFunctions for ${shopDomain}: ${JSON.stringify(res.errors)}`,
    );
  }

  const candidates = (res.data?.shopifyFunctions?.nodes ?? []).filter(
    (node) => node.apiType === CART_TRANSFORM_API_TYPE,
  );

  if (candidates.length === 0) {
    throw new Error(`[ensureCartTransform] cart-transform function not deployed for ${shopDomain}`);
  }

  const preferred = candidates.find((node) => CART_TRANSFORMER_TITLE_HINT.test(node.title));
  return (preferred ?? candidates[0]).id;
}

/**
 * Idempotently registers a `CartTransform` for a shop against the deployed
 * cart-transform Function, never clobbering a pre-existing transform — a
 * store can have at most one — and never creating a second one alongside a
 * foreign transform. Persists the resolved gid to `shopifyShop.cartTransformGid`
 * so subsequent calls short-circuit without hitting the Admin API at all.
 */
export async function ensureCartTransform(
  env: Env,
  shopDomain: string,
  shops: IShopRepository,
  shopId: string,
): Promise<{ gid: string; created: boolean } | { conflict: true }> {
  const shop = await shops.findById(shopId);

  if (shop?.cartTransformGid) {
    return { gid: shop.cartTransformGid, created: false };
  }

  const functionId = await resolveCartTransformFunctionId(env, shopDomain);

  const existingRes = await adminGraphql<CartTransformsQueryResult>(shopDomain, env, CART_TRANSFORMS_QUERY);
  if (existingRes.errors && existingRes.errors.length > 0) {
    throw new Error(
      `[ensureCartTransform] GraphQL errors resolving cartTransforms for ${shopDomain}: ${JSON.stringify(existingRes.errors)}`,
    );
  }

  const existingNodes = existingRes.data?.cartTransforms?.nodes ?? [];
  const ours = existingNodes.find((node) => node.functionId === functionId);
  if (ours) {
    await shops.setCartTransformGid(shopId, ours.id);
    return { gid: ours.id, created: false };
  }

  const foreign = existingNodes.find((node) => node.functionId !== functionId);
  if (foreign) {
    return { conflict: true };
  }

  const createRes = await adminGraphql<CartTransformCreateResult>(shopDomain, env, CART_TRANSFORM_CREATE_MUTATION, {
    functionId,
  });

  if (createRes.errors && createRes.errors.length > 0) {
    throw new Error(
      `[ensureCartTransform] GraphQL errors creating cartTransform for ${shopDomain}: ${JSON.stringify(createRes.errors)}`,
    );
  }

  const userErrors = createRes.data?.cartTransformCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `[ensureCartTransform] cartTransformCreate userErrors for ${shopDomain}: ${JSON.stringify(userErrors)}`,
    );
  }

  const gid = createRes.data?.cartTransformCreate?.cartTransform?.id;
  if (!gid) {
    throw new Error(
      `[ensureCartTransform] cartTransformCreate returned no cartTransform id for ${shopDomain}: ${JSON.stringify(createRes)}`,
    );
  }

  await shops.setCartTransformGid(shopId, gid);
  return { gid, created: true };
}
