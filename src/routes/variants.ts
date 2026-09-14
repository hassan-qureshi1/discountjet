import { Hono } from 'hono';
import { createDb } from '../db/db';
import type { AppEnv } from '../types/env.d';
import { adminGraphql } from '../lib/graphqlAdmin';
import { requireShopDomain } from '../lib/shopDomain';

export const variantRoutes = new Hono<AppEnv>();

/** Shopify's `nodes` query accepts at most 250 ids; the editor never needs
 * more than a handful, so this cap is about bounding the blast radius of a
 * malformed client request, not about the API limit. */
const MAX_IDS = 50;

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** `gid://shopify/ProductVariant/123` → `123`. Callers have already matched
 * the gid against its shape, so a miss here is a programming error. */
const numericId = (gid: string): string => {
  const match = gid.match(/(\d+)$/);
  if (!match) throw new Error(`[variants] unexpected gid shape: ${gid}`);
  return match[1];
};

interface ImageNode {
  url: string;
  altText: string | null;
}

interface VariantNode {
  id: string;
  title: string;
  image: ImageNode | null;
  product: { id: string; title: string; featuredImage: ImageNode | null } | null;
}

interface NodesResponse {
  nodes: (VariantNode | null)[];
}

const VARIANT_NODES_QUERY = `
  query BundleVariantNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        image {
          url
          altText
        }
        product {
          id
          title
          featuredImage {
            url
            altText
          }
        }
      }
    }
  }
`;

export interface ResolvedVariant {
  id: string;
  exists: boolean;
  /** Owning product gid — the resource picker pre-selects by product, so the
   * editor needs it to reopen the picker with the current items checked. */
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  adminUrl?: string;
  imageUrl?: string;
  imageAlt?: string;
}

// GET /api/variants?ids=<gid>,<gid> — resolves product + variant titles and a
// variant-level admin deep link for a set of variant gids, in ONE Admin call.
//
// Deliberately not persisted: the editor resolves names at page load so a
// merchant renaming a product in Shopify is reflected immediately, and so the
// app never holds a stale copy of catalogue data it doesn't own. The client
// can't call the Admin API itself (the offline token lives server-side), hence
// this endpoint.
variantRoutes.get('/api/variants', async (c) => {
  const raw = c.req.query('ids');
  if (!raw || raw.trim() === '') {
    return c.json({ error: 'Query parameter `ids` is required.' }, 400);
  }

  const requested = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  // De-duplicate while preserving first-seen order, so a bundle listing the
  // same variant twice costs one node, and the response stays stable.
  const ids = [...new Set(requested)];

  if (ids.length === 0) {
    return c.json({ error: 'Query parameter `ids` is required.' }, 400);
  }
  if (ids.length > MAX_IDS) {
    return c.json({ error: `Too many ids: ${ids.length} requested, max ${MAX_IDS}.` }, 400);
  }

  const invalid = ids.filter((id) => !VARIANT_GID.test(id));
  if (invalid.length > 0) {
    return c.json(
      { error: `Not ProductVariant ids: ${invalid.join(', ')}` },
      400,
    );
  }

  const shopDomain = await requireShopDomain(createDb(c.env.DB), c.get('shopId'));

  let result;
  try {
    result = await adminGraphql<NodesResponse>(shopDomain, c.env, VARIANT_NODES_QUERY, { ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to resolve variants: ${message}` }, 502);
  }

  if (result.errors && result.errors.length > 0) {
    return c.json({ error: `Failed to resolve variants: ${JSON.stringify(result.errors)}` }, 502);
  }

  // `nodes` returns one slot per requested id, in order, `null` where the id
  // no longer resolves (deleted variant). Index by id rather than trusting
  // position, then walk `ids` so every requested id gets exactly one entry.
  const byId = new Map<string, VariantNode>();
  for (const node of result.data?.nodes ?? []) {
    if (node?.id) byId.set(node.id, node);
  }

  const variants: ResolvedVariant[] = ids.map((id) => {
    const node = byId.get(id);
    // A variant whose product is missing can't be linked into the admin, so
    // it's reported the same as a deleted one rather than half-rendered.
    if (!node || !node.product) return { id, exists: false };

    // A variant only carries its own image when the merchant assigned one;
    // otherwise the product's featured image is what the admin itself shows.
    // Absent fields are omitted rather than sent as null, so the client can
    // branch on presence alone.
    const image = node.image ?? node.product.featuredImage;

    return {
      id,
      exists: true,
      productId: node.product.id,
      productTitle: node.product.title,
      variantTitle: node.title,
      adminUrl: `https://${shopDomain}/admin/products/${numericId(node.product.id)}/variants/${numericId(id)}`,
      ...(image ? { imageUrl: image.url } : {}),
      ...(image?.altText ? { imageAlt: image.altText } : {}),
    };
  });

  return c.json({ variants });
});
