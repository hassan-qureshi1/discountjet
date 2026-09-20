import type { Env } from '../types/env';
import { adminGraphql } from './graphqlAdmin';

/**
 * Minimal shape `compositionFromItems` needs from a bundle item.
 *
 * `price` is per-unit in MAJOR units (dollars) — the Rust function's
 * `BundleComponent.price` is a major-unit float, not minor units. The bundle
 * routes convert from the stored minor units before calling in. It is
 * required: a component the cart transform prices at 0 is a component given
 * away free at checkout, so there is no honest default to fall back on.
 */
export interface BundleItemLike {
  variantId: string;
  qty: number;
  price: number;
}

/**
 * The `$app:cart-transform.composition` metafield entry shape the Rust
 * cart-transform function's `BundleComponent` deserializes
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
// deserializes the whole `composition` array in one shot — a single
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
// number — but a non-finite (NaN/Infinity) value would serialize as `null`
// (deserialization failure) or fail `JSON.stringify` entirely. The type now
// makes `price` required, so this guards only the non-finite case — and it
// throws rather than substituting 0, because this value is the per-unit price
// the cart transform charges: a zero here is a component given away FREE at
// checkout. Unreachable today is not a reason to leave a silent zero on the
// checkout path.
function toSafePrice(price: number): number {
  if (!Number.isFinite(price)) {
    throw new Error(`[bundleMetafields] non-finite component price: ${price}`);
  }
  return price;
}

/**
 * Pure mapping from bundle items to the `$app:cart-transform.composition`
 * JSON array shape. Shopify-independent (no network calls) — the value the Rust
 * `bundle_expander` reads is `JSON.stringify(compositionFromItems(items))`.
 * Guarantees a valid integer `quantity` (>= 1), and throws rather than emit a
 * non-finite `price` the Rust side could not read (or, worse, a silent zero).
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
 * Writes the `$app:cart-transform.composition` metafield (app-owned reserved
 * namespace, key `composition`, type `json`) on an `expand` bundle's parent
 * variant — the JSON the Rust cart-transform function reads at checkout.
 * Fails loudly: throws on a transport error, GraphQL `userErrors`, or a
 * missing metafield id in the response (no `?? ''` masking of a failed
 * write).
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
        namespace: '$app:cart-transform',
        key: 'composition',
        type: 'json',
        value: JSON.stringify(composition),
      },
    ],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[writeComposition] GraphQL errors writing composition for ${parentVariantGid}: ${JSON.stringify(res.errors)}`,
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
 * Clears the `$app:cart-transform.composition` metafield on a variant
 * (identified by ownerId + namespace + key, not by metafield id) — called
 * when a bundle that had written it is deleted. Throws loudly on failure;
 * callers that treat delete-time clearing as best-effort should catch/log
 * rather than let this mask other failures.
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
        namespace: '$app:cart-transform',
        key: 'composition',
      },
    ],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[clearComposition] GraphQL errors clearing composition for ${parentVariantGid}: ${JSON.stringify(res.errors)}`,
    );
  }

  const userErrors = res.data?.metafieldsDelete?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `[clearComposition] metafieldsDelete userErrors for ${parentVariantGid}: ${JSON.stringify(userErrors)}`,
    );
  }
}

/**
 * The `$app:cart-transform.merge_bundles` metafield entry shape the Rust
 * cart-transform function's `MergeBundleConfig` deserializes
 * (`extensions/cart-transformer/src/config.rs`): `parentVariantId` and each
 * `sources` entry are `ProductVariant` GID strings, `price` is the merged
 * line's target price in DOLLARS (not cents), and `title` is optional.
 */
export interface MergeBundleConfig {
  parentVariantId: string;
  price: number;
  sources: string[];
  title?: string;
}

/** Minimal shape `mergeConfigEntry` needs from a bundle. `items` only supplies
 *  the `sources` variant ids — a merge bundle's price is the BUNDLE's, not any
 *  item's — but it is typed as `BundleItemLike` so both metafield transports
 *  take the one item shape. */
export interface MergeBundleLike {
  parentVariantId: string;
  price: number; // dollars
  items: BundleItemLike[];
  title?: string;
}

/**
 * Pure mapping from a `merge` bundle to its `$app:cart-transform.merge_bundles`
 * config array entry. Shopify-independent (no network calls). `sources` is
 * deduplicated by variant GID — Shopify's `linesMerge` operation rejects a
 * merge that references the same line twice, so a bundle whose `items` list
 * the same variant more than once (e.g. via qty edits that left a duplicate
 * row) must still only appear once in `sources`.
 */
export function mergeConfigEntry(bundle: MergeBundleLike): MergeBundleConfig {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const item of bundle.items) {
    const gid = toVariantGid(item.variantId);
    if (seen.has(gid)) continue;
    seen.add(gid);
    sources.push(gid);
  }

  return {
    parentVariantId: toVariantGid(bundle.parentVariantId),
    price: bundle.price,
    sources,
    ...(bundle.title ? { title: bundle.title } : {}),
  };
}

const SHOP_MERGE_BUNDLES_QUERY = `
  query ShopMergeBundlesConfig {
    shop {
      id
      metafield(namespace: "$app:cart-transform", key: "merge_bundles") {
        id
        value
      }
    }
  }
`;

interface ShopMergeBundlesQueryResponse {
  shop: {
    id: string;
    metafield: { id: string; value: string } | null;
  } | null;
}

/** Tolerant parse of the raw `$app:cart-transform.merge_bundles` metafield value: missing/invalid/non-array -> `[]`. */
function parseMergeBundlesArray(raw: string | null | undefined): MergeBundleConfig[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MergeBundleConfig[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reads the shop's own gid and the current `$app:cart-transform.merge_bundles`
 * array in one round-trip — both `upsertMergeConfig` and `removeMergeConfig`
 * need the shop gid (the metafield's `ownerId`) plus the existing array to
 * read-modify-write. Throws loudly on a transport error or a missing shop id
 * (never silently proceeds with an unknown owner).
 */
async function readShopMergeBundles(
  env: Env,
  shopDomain: string,
): Promise<{ shopGid: string; entries: MergeBundleConfig[] }> {
  const res = await adminGraphql<ShopMergeBundlesQueryResponse>(shopDomain, env, SHOP_MERGE_BUNDLES_QUERY);

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[mergeBundlesConfig] GraphQL errors reading merge_bundles for ${shopDomain}: ${JSON.stringify(res.errors)}`,
    );
  }

  const shopGid = res.data?.shop?.id;
  if (!shopGid) {
    throw new Error(`[mergeBundlesConfig] no shop id returned for ${shopDomain}: ${JSON.stringify(res)}`);
  }

  return { shopGid, entries: parseMergeBundlesArray(res.data?.shop?.metafield?.value ?? null) };
}

/**
 * Read-modify-write the shop `$app:cart-transform.merge_bundles` metafield
 * (app-owned reserved namespace, key `merge_bundles`, type `json`, owned by
 * the shop itself) — replaces any existing entry with the same
 * `parentVariantId`, or appends `entry` when none matches, then writes the
 * whole array back. Fails loudly: throws on a transport error, GraphQL
 * `userErrors`, or a missing metafield id in the response.
 */
export async function upsertMergeConfig(
  env: Env,
  shopDomain: string,
  entry: MergeBundleConfig,
): Promise<{ metafieldGid: string }> {
  const { shopGid, entries } = await readShopMergeBundles(env, shopDomain);
  const next = [...entries.filter((e) => e.parentVariantId !== entry.parentVariantId), entry];

  const res = await adminGraphql<MetafieldsSetResponse>(shopDomain, env, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: shopGid,
        namespace: '$app:cart-transform',
        key: 'merge_bundles',
        type: 'json',
        value: JSON.stringify(next),
      },
    ],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[upsertMergeConfig] GraphQL errors writing merge_bundles for ${shopDomain}: ${JSON.stringify(res.errors)}`,
    );
  }

  const userErrors = res.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `[upsertMergeConfig] metafieldsSet userErrors for ${shopDomain}: ${JSON.stringify(userErrors)}`,
    );
  }

  const metafieldGid = res.data?.metafieldsSet?.metafields?.[0]?.id;
  if (!metafieldGid) {
    throw new Error(
      `[upsertMergeConfig] metafieldsSet returned no metafield id for ${shopDomain}: ${JSON.stringify(res)}`,
    );
  }

  return { metafieldGid };
}

/**
 * Removes a bundle's entry from the shop `$app:cart-transform.merge_bundles`
 * metafield (matched by `parentVariantId`) — called when a `merge` bundle
 * that had written it is deleted. Writes the filtered array back, or clears
 * the metafield entirely (via `metafieldsDelete`) when no entries remain,
 * rather than leaving a stray `"[]"` behind. Throws loudly on failure;
 * callers that treat delete-time clearing as best-effort should catch/log
 * rather than let this mask other failures.
 */
export async function removeMergeConfig(
  env: Env,
  shopDomain: string,
  parentVariantId: string,
): Promise<void> {
  const { shopGid, entries } = await readShopMergeBundles(env, shopDomain);
  const next = entries.filter((e) => e.parentVariantId !== parentVariantId);

  if (next.length === 0) {
    const res = await adminGraphql<MetafieldsDeleteResponse>(shopDomain, env, METAFIELDS_DELETE_MUTATION, {
      metafields: [{ ownerId: shopGid, namespace: '$app:cart-transform', key: 'merge_bundles' }],
    });

    if (res.errors && res.errors.length > 0) {
      throw new Error(
        `[removeMergeConfig] GraphQL errors clearing merge_bundles for ${shopDomain}: ${JSON.stringify(res.errors)}`,
      );
    }

    const userErrors = res.data?.metafieldsDelete?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        `[removeMergeConfig] metafieldsDelete userErrors for ${shopDomain}: ${JSON.stringify(userErrors)}`,
      );
    }
    return;
  }

  const res = await adminGraphql<MetafieldsSetResponse>(shopDomain, env, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: shopGid,
        namespace: '$app:cart-transform',
        key: 'merge_bundles',
        type: 'json',
        value: JSON.stringify(next),
      },
    ],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[removeMergeConfig] GraphQL errors writing merge_bundles for ${shopDomain}: ${JSON.stringify(res.errors)}`,
    );
  }

  const userErrors = res.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `[removeMergeConfig] metafieldsSet userErrors for ${shopDomain}: ${JSON.stringify(userErrors)}`,
    );
  }
}
