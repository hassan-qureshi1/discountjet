import type { Env } from '../types/env';
import { adminGraphql } from './graphqlAdmin';

/**
 * The two `$app:cart-transform` metafield DEFINITIONS this app used to create
 * via `metafieldDefinitionCreate` (variant `composition`, shop
 * `merge_bundles`). A definition with `access.admin: MERCHANT_READ` turns out
 * to make Shopify REJECT this app's own `metafieldsSet` writes to that
 * namespace/key (a userError), which broke `writeComposition`/
 * `upsertMergeConfig` with a 502. The definition was only admin-UI polish —
 * visibility/read-only-ness — never required for the underlying metafield
 * (which is a plain `$app:` reserved-namespace metafield: app-owned,
 * merchant-can't-edit, and auto-deleted by Shopify on uninstall regardless of
 * whether a definition exists). So this app no longer creates them, and this
 * module now only cleans up any that were already created on a store.
 */
const CART_TRANSFORM_METAFIELD_DEFINITIONS = [
  { ownerType: 'PRODUCTVARIANT', namespace: '$app:cart-transform', key: 'composition' },
  { ownerType: 'SHOP', namespace: '$app:cart-transform', key: 'merge_bundles' },
] as const;

const METAFIELD_DEFINITION_FIND_QUERY = /* GraphQL */ `
  query FindCartTransformMetafieldDefinition($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: $ownerType, namespace: $namespace, key: $key) {
      nodes {
        id
      }
    }
  }
`;

interface MetafieldDefinitionFindResponse {
  metafieldDefinitions: { nodes: Array<{ id: string }> } | null;
}

const METAFIELD_DEFINITION_DELETE_MUTATION = /* GraphQL */ `
  mutation DeleteCartTransformMetafieldDefinition($id: ID!, $deleteAllAssociatedMetafields: Boolean!) {
    metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: $deleteAllAssociatedMetafields) {
      deletedDefinitionId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldDefinitionDeleteResponse {
  metafieldDefinitionDelete: {
    deletedDefinitionId: string | null;
    userErrors: Array<{ field: string[]; message: string; code: string }>;
  } | null;
}

/**
 * Idempotently removes the two `$app:cart-transform` metafield DEFINITIONS
 * (variant `composition`, shop `merge_bundles`) if present, via
 * `metafieldDefinitionDelete(deleteAllAssociatedMetafields: false)` — the
 * existing metafield VALUES (the actual `composition`/`merge_bundles` data
 * the Rust cart-transform function reads) are left untouched, only the
 * definition (admin-visibility/read-only-ness metadata) is removed. A
 * definition that doesn't exist is a no-op success. Runs non-fatally: any
 * userError or transport error is logged and swallowed, since this is called
 * from install and the activation endpoint and must never fail either.
 */
export async function removeCartTransformMetafieldDefinitions(env: Env, shopDomain: string): Promise<void> {
  for (const { ownerType, namespace, key } of CART_TRANSFORM_METAFIELD_DEFINITIONS) {
    try {
      const findRes = await adminGraphql<MetafieldDefinitionFindResponse>(
        shopDomain,
        env,
        METAFIELD_DEFINITION_FIND_QUERY,
        { ownerType, namespace, key },
      );

      if (findRes.errors && findRes.errors.length > 0) {
        console.error(
          `[removeCartTransformMetafieldDefinitions] GraphQL errors finding ${namespace}.${key} for ${shopDomain}: ${JSON.stringify(findRes.errors)}`,
        );
        continue;
      }

      const id = findRes.data?.metafieldDefinitions?.nodes[0]?.id;
      if (!id) {
        console.log(
          `[removeCartTransformMetafieldDefinitions] ${namespace}.${key} has no definition for ${shopDomain}, nothing to remove`,
        );
        continue;
      }

      const deleteRes = await adminGraphql<MetafieldDefinitionDeleteResponse>(
        shopDomain,
        env,
        METAFIELD_DEFINITION_DELETE_MUTATION,
        { id, deleteAllAssociatedMetafields: false },
      );

      if (deleteRes.errors && deleteRes.errors.length > 0) {
        console.error(
          `[removeCartTransformMetafieldDefinitions] GraphQL errors deleting ${namespace}.${key} for ${shopDomain}: ${JSON.stringify(deleteRes.errors)}`,
        );
        continue;
      }

      const userErrors = deleteRes.data?.metafieldDefinitionDelete?.userErrors ?? [];
      if (userErrors.length > 0) {
        console.error(
          `[removeCartTransformMetafieldDefinitions] metafieldDefinitionDelete userErrors for ${namespace}.${key} on ${shopDomain}: ${JSON.stringify(userErrors)}`,
        );
        continue;
      }

      console.log(`[removeCartTransformMetafieldDefinitions] removed ${namespace}.${key} for ${shopDomain}`);
    } catch (err) {
      console.error(
        `[removeCartTransformMetafieldDefinitions] threw removing ${namespace}.${key} for ${shopDomain}:`,
        err,
      );
    }
  }
}

const METAFIELD_SETUP_STATUS_QUERY = /* GraphQL */ `
  query MetafieldSetupStatus {
    shop {
      metafield(namespace: "$app:cart-transform", key: "merge_bundles") {
        value
      }
    }
  }
`;

interface MetafieldSetupStatusResponse {
  shop: { metafield: { value: string } | null } | null;
}

export interface MetafieldSetupStatus {
  mergeBundlesValuePresent: boolean;
}

/**
 * Checks whether the shop-level `merge_bundles` metafield actually has a
 * (non-empty) value written. Read-only. Throws on a transport/GraphQL-level
 * failure — the caller decides how to degrade (e.g. omit `metafields` from
 * its response).
 */
export async function getMetafieldSetupStatus(env: Env, shopDomain: string): Promise<MetafieldSetupStatus> {
  const res = await adminGraphql<MetafieldSetupStatusResponse>(shopDomain, env, METAFIELD_SETUP_STATUS_QUERY);

  if (res.errors && res.errors.length > 0) {
    throw new Error(`[getMetafieldSetupStatus] GraphQL errors for ${shopDomain}: ${JSON.stringify(res.errors)}`);
  }

  const value = res.data?.shop?.metafield?.value;
  const mergeBundlesValuePresent = value != null && value !== '' && value !== '[]';

  return { mergeBundlesValuePresent };
}
