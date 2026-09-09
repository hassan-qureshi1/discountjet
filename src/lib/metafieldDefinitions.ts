import type { Env } from '../types/env';
import { adminGraphql } from './graphqlAdmin';

/**
 * Definitions for the app-owned `$app:cart-transform` metafields that the
 * Rust cart-transform function reads (`extensions/cart-transformer/src/config.rs`):
 * the variant `composition` array (written by `writeComposition` in
 * `bundleMetafields.ts`) and the shop `merge_bundles` array (written by
 * `upsertMergeConfig`). Both are `MERCHANT_READ` — visible to the merchant in
 * the admin but not editable there — and, being under the `$app:` reserved
 * namespace, are automatically deleted by Shopify when the app is uninstalled
 * (no manual cleanup webhook needed).
 */
const CART_TRANSFORM_METAFIELD_DEFINITIONS = [
  {
    ownerType: 'PRODUCTVARIANT',
    namespace: '$app:cart-transform',
    key: 'composition',
    name: 'Bundle composition',
    type: 'json',
    access: { admin: 'MERCHANT_READ' },
  },
  {
    ownerType: 'SHOP',
    namespace: '$app:cart-transform',
    key: 'merge_bundles',
    name: 'Cart-transform merge bundles',
    type: 'json',
    access: { admin: 'MERCHANT_READ' },
  },
] as const;

const METAFIELD_DEFINITION_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateCartTransformMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldDefinitionCreateResponse {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string } | null;
    userErrors: Array<{ field: string[]; message: string; code: string }>;
  } | null;
}

// `MetafieldDefinitionCreateUserErrorCode` values that mean "a definition for
// this namespace/key/ownerType already exists" — i.e. the idempotent no-op
// case this function is designed to swallow, not a real failure.
const ALREADY_EXISTS_CODES = new Set(['TAKEN', 'UNSTRUCTURED_ALREADY_EXISTS']);

/**
 * Idempotently creates the two `$app:cart-transform` metafield definitions
 * (variant `composition`, shop `merge_bundles`) via `metafieldDefinitionCreate`.
 * Runs non-fatally: a definition that already exists (userError code `TAKEN`
 * / `UNSTRUCTURED_ALREADY_EXISTS`) is logged and treated as success; any
 * other userError or transport error is logged and swallowed too, since this
 * is called from install and a definition-create failure must never fail
 * install (the underlying metafield writes work regardless of whether the
 * definition — which only controls admin visibility/read-only-ness — exists).
 */
export async function ensureCartTransformMetafieldDefinitions(env: Env, shopDomain: string): Promise<void> {
  for (const definition of CART_TRANSFORM_METAFIELD_DEFINITIONS) {
    try {
      const res = await adminGraphql<MetafieldDefinitionCreateResponse>(
        shopDomain,
        env,
        METAFIELD_DEFINITION_CREATE_MUTATION,
        { definition },
      );

      if (res.errors && res.errors.length > 0) {
        console.error(
          `[ensureCartTransformMetafieldDefinitions] GraphQL errors creating ${definition.namespace}.${definition.key} for ${shopDomain}: ${JSON.stringify(res.errors)}`,
        );
        continue;
      }

      const userErrors = res.data?.metafieldDefinitionCreate?.userErrors ?? [];
      const realErrors = userErrors.filter((e) => !ALREADY_EXISTS_CODES.has(e.code));

      if (userErrors.length > 0 && realErrors.length === 0) {
        console.log(
          `[ensureCartTransformMetafieldDefinitions] ${definition.namespace}.${definition.key} already exists for ${shopDomain}, skipping`,
        );
        continue;
      }

      if (realErrors.length > 0) {
        console.error(
          `[ensureCartTransformMetafieldDefinitions] metafieldDefinitionCreate userErrors for ${definition.namespace}.${definition.key} on ${shopDomain}: ${JSON.stringify(realErrors)}`,
        );
        continue;
      }

      console.log(
        `[ensureCartTransformMetafieldDefinitions] created ${definition.namespace}.${definition.key} for ${shopDomain}`,
      );
    } catch (err) {
      console.error(
        `[ensureCartTransformMetafieldDefinitions] threw creating ${definition.namespace}.${definition.key} for ${shopDomain}:`,
        err,
      );
    }
  }
}
