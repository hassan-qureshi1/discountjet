import { useResourceDetails } from "./useResourceDetails";

export interface SelectedItem {
  productId?: string;
  variantId?: string;
  productTitle?: string;
  variantTitle?: string;
  sku?: string;
  image?: string;
}

interface Props {
  items: SelectedItem[];
  selectorType: string;
  /** Called with the numeric id (productId in product mode, variantId otherwise). */
  onRemove: (id: string) => void;
  label: string;
}

/**
 * Renders the selected products/variants as compact chips — a mini product
 * image + name (+ SKU) + remove (×). The metafield only stores IDs, so
 * name/variant/image are hydrated live via useResourceDetails; freshly-picked
 * items render instantly from the picker data.
 */
export function SelectedResources({ items, selectorType, onRemove, label }: Props) {
  const isProductId = selectorType === "product_id";
  const details = useResourceDetails(items, selectorType);

  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <s-stack gap="small-100">
      <s-stack direction="inline" gap="small-100" alignItems="center">
        <s-text type="strong">{label}</s-text>
        <s-badge tone="info">{String(items.length)}</s-badge>
      </s-stack>

      <s-stack direction="inline" gap="small-100">
        {items.map((item) => {
          const id = (isProductId ? item.productId : item.variantId) ?? "";
          const detail = details[id] ?? ({} as Partial<ReturnType<typeof useResourceDetails>[string]>);
          const imageUrl = item.image || detail.imageUrl || "";
          const productTitle = item.productTitle || detail.productTitle || "";
          const variantTitle = isProductId ? "" : item.variantTitle || detail.variantTitle || "";
          const sku = isProductId ? "" : item.sku || detail.sku || "";

          let name: string;
          if (isProductId) {
            name = productTitle || id;
          } else {
            const variantLabel =
              variantTitle && variantTitle !== "Default Title" ? variantTitle : productTitle;
            name = variantLabel || id;
          }
          if (sku) name = `${name} · ${sku}`;

          return (
            <s-box
              key={id}
              background="subdued"
              borderWidth="base"
              borderRadius="large-200"
              padding="small-200"
            >
              {/* Grid (not an inline stack) so the ✕ never wraps to a new line */}
              <s-grid gridTemplateColumns="auto auto auto" gap="small-100" alignItems="center">
                <s-thumbnail size="small-200" src={imageUrl || undefined} alt={detail.imageAlt || name} />
                <s-text>{name}</s-text>
                <s-clickable onClick={() => onRemove(id)} accessibilityLabel={`Remove ${name}`}>
                  <s-text color="subdued">✕</s-text>
                </s-clickable>
              </s-grid>
            </s-box>
          );
        })}
      </s-stack>
    </s-stack>
  );
}
