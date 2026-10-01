import type { Env } from '../types/env';
import { adminGraphql } from './graphqlAdmin';

/** Shopify's `nodes` query accepts at most 250 ids; a bundle never needs more
 * than a handful, so this cap bounds a malformed request, not the API limit. */
export const MAX_VARIANT_IDS = 50;

export const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** `gid://shopify/ProductVariant/123` -> `123`. */
export function numericId(gid: string): string {
  const match = gid.match(/(\d+)$/);
  if (!match) throw new Error(`[variantResolver] unexpected gid shape: ${gid}`);
  return match[1];
}

interface ImageNode { url: string; altText: string | null }

interface VariantNode {
  id: string;
  title: string;
  price: string;
  image: ImageNode | null;
  product: {
    id: string;
    title: string;
    handle: string | null;
    featuredImage: ImageNode | null;
    /** Null when the product isn't published to the Online Store. */
    onlineStoreUrl: string | null;
  } | null;
}

interface NodesResponse {
  nodes: (VariantNode | null)[];
  shop: { primaryDomain: { url: string } | null } | null;
}

const VARIANT_NODES_QUERY = `
  query BundleVariantNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
        image { url altText }
        product { id title handle featuredImage { url altText } onlineStoreUrl }
      }
    }
    # Same request, not a second round trip: the fallback storefront url needs
    # the merchant's own domain, and asking for it here costs nothing extra.
    shop { primaryDomain { url } }
  }
`;

export interface ResolvedVariant {
  id: string;
  exists: boolean;
  /** Owning product gid — the resource picker pre-selects by product. */
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  adminUrl?: string;
  /**
   * The product's live storefront page, as Shopify reports it — absent when
   * the product isn't published to the Online Store.
   *
   * Prefers Shopify's own `onlineStoreUrl`, which is authoritative and
   * survives a renamed handle. Falls back to the shop's primary domain plus
   * the handle so a merchant still has a way through to an unpublished
   * product's page — that url can 404 while the product stays unpublished,
   * which is the deliberate trade for not dead-ending the merchant.
   */
  storefrontUrl?: string;
  imageUrl?: string;
  imageAlt?: string;
  /** Per-unit price as an exact decimal string in the shop's currency. */
  price?: string;
}

/**
 * Where a shopper would see this product.
 *
 * `onlineStoreUrl` is Shopify's own answer and wins whenever it exists: it is
 * canonical and survives a renamed handle. When the product isn't published to
 * the Online Store Shopify returns null, so we assemble one from the shop's
 * primary domain instead rather than leaving the merchant with no way through.
 * That assembled url can 404 until the product is published — a link that may
 * not resolve was judged better than no link at all.
 */
function storefrontUrlFor(
  product: { handle: string | null; onlineStoreUrl: string | null },
  primaryDomain: string | undefined,
): string | undefined {
  if (product.onlineStoreUrl) return product.onlineStoreUrl;
  if (!primaryDomain || !product.handle) return undefined;
  return `${primaryDomain}/products/${product.handle}`;
}

/** `Blue T-Shirt / Large`, or undefined when the variant no longer resolves. */
export function variantDisplayName(v: ResolvedVariant): string | undefined {
  if (!v.exists) return undefined;
  return [v.productTitle, v.variantTitle].filter(Boolean).join(' / ') || undefined;
}

/**
 * Resolves variant gids to titles, price, an image and an admin deep link in ONE
 * Admin call. Shared by `GET /api/variants` (so the editor can render names) and
 * by the bundle save path (so item prices come from Shopify, not the client).
 *
 * Returns one entry per requested id — `exists: false` for a deleted variant —
 * so a caller can always index the map rather than checking for a miss.
 */
export async function resolveVariants(
  shopDomain: string,
  env: Env,
  ids: string[],
): Promise<Map<string, ResolvedVariant>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  // Both failure modes carry the same prefix. A transport failure (the call
  // itself throwing) is just as much a "couldn't resolve the variants" as a
  // GraphQL `errors` payload, and the callers surface `err.message` verbatim —
  // so prefixing only one of them would make a network failure reach the
  // merchant as a bare `fetch failed` with no hint of what was being fetched.
  let result;
  try {
    result = await adminGraphql<NodesResponse>(shopDomain, env, VARIANT_NODES_QUERY, {
      ids: unique,
    });
  } catch (err) {
    throw new Error(
      `Failed to resolve variants: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Failed to resolve variants: ${JSON.stringify(result.errors)}`);
  }

  const byId = new Map<string, VariantNode>();
  for (const node of result.data?.nodes ?? []) {
    if (node?.id) byId.set(node.id, node);
  }

  // Trailing slash stripped so the join below can't produce `//products/`.
  const primaryDomain = result.data?.shop?.primaryDomain?.url?.replace(/\/+$/, '');

  const resolved = new Map<string, ResolvedVariant>();
  for (const id of unique) {
    const node = byId.get(id);
    // A variant whose product is missing can't be linked into the admin, so it
    // is reported the same as a deleted one rather than half-rendered.
    if (!node || !node.product) {
      resolved.set(id, { id, exists: false });
      continue;
    }

    const image = node.image ?? node.product.featuredImage;
    resolved.set(id, {
      id,
      exists: true,
      productId: node.product.id,
      productTitle: node.product.title,
      variantTitle: node.title,
      price: node.price,
      adminUrl: `https://${shopDomain}/admin/products/${numericId(node.product.id)}/variants/${numericId(id)}`,
      ...(storefrontUrlFor(node.product, primaryDomain)
        ? { storefrontUrl: storefrontUrlFor(node.product, primaryDomain) as string }
        : {}),
      ...(image ? { imageUrl: image.url } : {}),
      ...(image?.altText ? { imageAlt: image.altText } : {}),
    });
  }

  return resolved;
}
