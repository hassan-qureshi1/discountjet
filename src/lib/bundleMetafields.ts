import type { Env } from '../types/env';
import { adminGraphql } from './graphqlAdmin';

/** Minimal shape `compositionFromItems` needs from a bundle item. */
export interface BundleItemLike {
  variantId: string;
  qty: number;
  price?: number; // per-unit dollars; missing treated as 0
}

/**
 * The `bundle.composition_v2` metafield entry shape the Rust cart-transform
 * function's `BundleComponent` deserializes
 * (`extensions/cart-transformer/src/config.rs`): `{ id, quantity, price }`
 * where `id` is a `ProductVariant` GID string, `quantity` an integer, and
 * `price` the per-unit price in dollars (not cents).
 */
export interface CompositionEntry {
  id: string;
  quantity: number;
  price: number;
}

const VARIANT_GID_PREFIX = 'gid://shopify/ProductVariant/';

/** Normalizes a bare numeric variant id to a GID; passes an existing GID through unchanged. */
function toVariantGid(variantId: string): string {
  return variantId.startsWith('gid://') ? variantId : `${VARIANT_GID_PREFIX}${variantId}`;
}

// The Rust `BundleComponent.quantity` is `i64` and `bundle_expander.rs`
// deserializes the whole `composition_v2` array in one shot — a single
// non-integer (or non-finite) quantity fails deserialization and aborts the
// ENTIRE cart-transform invocation for that cart, not just the one line. The
// route does no shape validation on `body.items`, so this guard is the only
// thing standing between a malformed qty and a broken checkout. Round to the
// nearest integer and clamp to at least 1 (a 0/negative/NaN/Infinity qty
// becomes 1 rather than emitting something the Rust side can't parse).
function toSafeQuantity(qty: number): number {
  const rounded = Math.round(qty);
  return Number.isFinite(rounded) ? Math.max(1, rounded) : 1;
}

// `price` is `f64` on the Rust side, which parses fine from any finite JSON
// number — but a non-finite (NaN/Infinity) or missing value would either
// serialize as `null` (deserialization failure) or fail `JSON.stringify`
// entirely. Fall back to 0 rather than propagate garbage.
function toSafePrice(price: number | undefined): number {
  return typeof price === 'number' && Number.isFinite(price) ? price : 0;
}

/**
 * Pure mapping from bundle items to the `bundle.composition_v2` JSON array
 * shape. Shopify-independent (no network calls) — the value the Rust
 * `bundle_expander` reads is `JSON.stringify(compositionFromItems(items))`.
 * Guarantees a valid integer `quantity` (>= 1) and a finite `price` even if
 * the caller's input isn't shape-validated upstream.
 */
export function compositionFromItems(items: BundleItemLike[]): CompositionEntry[] {
  return items.map((item) => ({
    id: toVariantGid(item.variantId),
    quantity: toSafeQuantity(item.qty),
    price: toSafePrice(item.price),
  }));
}

const METAFIELDS_SET_MUTATION = `
  mutation SetBundleComposition($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE_MUTATION = `
  mutation DeleteBundleComposition($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }
`;

interface MetafieldsSetResponse {
  metafieldsSet: {
    metafields: Array<{ id: string }> | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
}

interface MetafieldsDeleteResponse {
  metafieldsDelete: {
    deletedMetafields: Array<{ key: string; namespace: string; ownerId: string }> | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
}

/**
 * Writes the `bundle.composition_v2` metafield (namespace `bundle`, key
 * `composition_v2`, type `json`) on an `expand` bundle's parent variant —
 * the JSON the Rust cart-transform function reads at checkout. Fails loudly:
 * throws on a transport error, GraphQL `userErrors`, or a missing metafield
 * id in the response (no `?? ''` masking of a failed write).
 */
export async function writeComposition(
  env: Env,
  shopDomain: string,
  parentVariantGid: string,
  items: BundleItemLike[],
): Promise<{ metafieldGid: string }> {
  const composition = compositionFromItems(items);

  const res = await adminGraphql<MetafieldsSetResponse>(shopDomain, env, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: parentVariantGid,
        namespace: 'bundle',
        key: 'composition_v2',
        type: 'json',
        value: JSON.stringify(composition),
      },
    ],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[writeComposition] GraphQL errors writing composition_v2 for ${parentVariantGid}: ${JSON.stringify(res.errors)}`,
    );
  }

  const userErrors = res.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `[writeComposition] metafieldsSet userErrors for ${parentVariantGid}: ${JSON.stringify(userErrors)}`,
    );
  }

  const metafieldGid = res.data?.metafieldsSet?.metafields?.[0]?.id;
  if (!metafieldGid) {
    throw new Error(
      `[writeComposition] metafieldsSet returned no metafield id for ${parentVariantGid}: ${JSON.stringify(res)}`,
    );
  }

  return { metafieldGid };
}

/**
 * Clears the `bundle.composition_v2` metafield on a variant (identified by
 * ownerId + namespace + key, not by metafield id) — called when a bundle
 * that had written it is deleted. Throws loudly on failure; callers that
 * treat delete-time clearing as best-effort should catch/log rather than
 * let this mask other failures.
 */
export async function clearComposition(
  env: Env,
  shopDomain: string,
  parentVariantGid: string,
): Promise<void> {
  const res = await adminGraphql<MetafieldsDeleteResponse>(shopDomain, env, METAFIELDS_DELETE_MUTATION, {
    metafields: [
      {
        ownerId: parentVariantGid,
        namespace: 'bundle',
        key: 'composition_v2',
      },
    ],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[clearComposition] GraphQL errors clearing composition_v2 for ${parentVariantGid}: ${JSON.stringify(res.errors)}`,
    );
  }

  const userErrors = res.data?.metafieldsDelete?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `[clearComposition] metafieldsDelete userErrors for ${parentVariantGid}: ${JSON.stringify(userErrors)}`,
    );
  }
}
