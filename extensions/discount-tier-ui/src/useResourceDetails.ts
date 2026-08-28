import { useEffect, useRef, useState } from "preact/hooks";
// `shopify` is provided as a global by the Shopify UI extension runtime.

export interface ResourceDetail {
  productTitle: string;
  variantTitle: string;
  sku: string;
  imageUrl: string;
  imageAlt: string;
}

interface DetailItem {
  productId?: string;
  variantId?: string;
  image?: string;
}

interface ResourceNode {
  id: string;
  title?: string;
  sku?: string;
  image?: { url?: string; altText?: string } | null;
  featuredImage?: { url?: string; altText?: string } | null;
  product?: { id: string; title?: string; featuredImage?: { url?: string; altText?: string } | null };
}

/**
 * Fetches display details (title, variant title, sku, image) for the selected
 * products/variants via the Admin GraphQL API. The metafield only persists IDs,
 * so this re-hydrates everything needed to render the selection. Freshly-picked
 * items already carry image/title/sku from the resource picker and skip the
 * fetch; only reloaded selections are looked up. Results are cached per id for
 * the component's lifetime. Requires the app's `read_products` access scope.
 */
export function useResourceDetails(
  items: DetailItem[],
  selectorType: string,
): Record<string, ResourceDetail> {
  const isProductId = selectorType === "product_id";
  const [detailsById, setDetailsById] = useState<Record<string, ResourceDetail>>({});
  const cacheRef = useRef<Record<string, ResourceDetail>>({});

  const idsNeedingFetch = (Array.isArray(items) ? items : [])
    .filter((item) => !item?.image)
    .map((item) => (isProductId ? item?.productId : item?.variantId))
    .filter((id): id is string => Boolean(id))
    .map(String);
  const idKey = `${isProductId ? "p" : "v"}:${idsNeedingFetch.slice().sort().join(",")}`;

  useEffect(() => {
    let cancelled = false;
    const missing = idsNeedingFetch.filter((id) => !cacheRef.current[id]);

    if (missing.length === 0) {
      setDetailsById({ ...cacheRef.current });
      return;
    }

    const gids = missing.map((id) =>
      isProductId ? `gid://shopify/Product/${id}` : `gid://shopify/ProductVariant/${id}`,
    );

    const query = `#graphql
      query GetResourceDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product { id title featuredImage { url altText } }
          ... on ProductVariant {
            id title sku image { url altText }
            product { id title featuredImage { url altText } }
          }
        }
      }`;

    shopify
      .query<{ nodes: (ResourceNode | null)[] }>(query, { variables: { ids: gids } })
      .then((res) => {
        if (cancelled) return;
        if (res?.errors?.length) {
          // Most likely cause: the app is missing the read_products access scope.
          console.error("Resource details query returned errors:", res.errors);
        }
        const nodes = res?.data?.nodes ?? [];
        nodes.forEach((node) => {
          if (!node?.id) return;
          if (node.id.includes("/ProductVariant/")) {
            const numeric = node.id.match(/ProductVariant\/(\d+)/)?.[1];
            if (!numeric) return;
            const image = node.image || node.product?.featuredImage;
            cacheRef.current[numeric] = {
              productTitle: node.product?.title || "",
              variantTitle: node.title || "",
              sku: node.sku || "",
              imageUrl: image?.url || "",
              imageAlt: image?.altText || node.product?.title || "",
            };
          } else if (node.id.includes("/Product/")) {
            const numeric = node.id.match(/Product\/(\d+)/)?.[1];
            if (!numeric) return;
            cacheRef.current[numeric] = {
              productTitle: node.title || "",
              variantTitle: "",
              sku: "",
              imageUrl: node.featuredImage?.url || "",
              imageAlt: node.featuredImage?.altText || node.title || "",
            };
          }
        });
        setDetailsById({ ...cacheRef.current });
      })
      .catch((error) => {
        console.error("Failed to fetch resource details:", error);
      });

    return () => {
      cancelled = true;
    };
    // idKey encodes the exact set of ids; re-run only when it changes.
  }, [idKey]);

  return detailsById;
}
