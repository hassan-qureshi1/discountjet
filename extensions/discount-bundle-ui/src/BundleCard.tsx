import { useMemo } from "preact/hooks";
import type { Bundle, Item, SelectorType } from "./config";
import { parseItems } from "./config";
import { SelectedResources } from "./SelectedResources";

interface Props {
  bundle: Bundle;
  bundleIndex: number;
  allBundles: Bundle[];
  onUpdate: (field: keyof Bundle, value: string | boolean) => void;
  onRemove: () => void;
  /** Which slice of the card to render. Omit to render everything (default). */
  section?: "products" | "rules";
}

const numericId = (gid: string): string => gid.split("/").pop() ?? "";

async function pickResources(selectorType: SelectorType, current: Item[]): Promise<Item[] | null> {
  const isProduct = selectorType === "product_id";
  if (isProduct) {
    const selectionIds = current
      .filter((p) => p.productId)
      .map((p) => ({ id: `gid://shopify/Product/${p.productId}` }));
    const selection = (await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      filter: { variants: false, draft: false, archived: false },
      selectionIds,
    })) as Array<{ id: string; title?: string }> | undefined;
    if (!selection) return null;
    const map = new Map<string, Item>();
    for (const product of selection) {
      const productId = numericId(product.id);
      if (productId) map.set(productId, { productId, productTitle: product.title ?? "" });
    }
    return [...map.values()];
  }
  const selectionIds = current
    .filter((v) => v.variantId)
    .map((v) => ({ id: `gid://shopify/ProductVariant/${v.variantId}` }));
  const selection = (await shopify.resourcePicker({
    type: "product",
    multiple: true,
    action: "select",
    filter: { variants: true, draft: false, archived: false },
    selectionIds,
  })) as
    | Array<{ id: string; title?: string; variants?: Array<{ id: string; title?: string; sku?: string }> }>
    | undefined;
  if (!selection) return null;
  const map = new Map<string, Item>();
  for (const product of selection) {
    const productId = numericId(product.id);
    for (const variant of product.variants ?? []) {
      const variantId = numericId(variant.id);
      if (productId && variantId) {
        map.set(variantId, {
          productId,
          variantId,
          productTitle: product.title ?? "",
          variantTitle: variant.title ?? "",
          sku: variant.sku ?? "",
        });
      }
    }
  }
  return [...map.values()];
}

export function BundleCard({ bundle, bundleIndex, allBundles, onUpdate, onRemove, section }: Props) {
  const sourceItems = useMemo(() => parseItems(bundle.source_variants), [bundle.source_variants]);
  const targetItems = useMemo(() => parseItems(bundle.target_variants), [bundle.target_variants]);
  const sourceIsProduct = bundle.sourceSelectorType === "product_id";
  const targetIsProduct = bundle.targetSelectorType === "product_id";
  const isPercentage = bundle.operator === "percentage";
  const renderProducts = !section || section === "products";
  const renderRules = !section || section === "rules";

  const chooseSource = async () => {
    const items = await pickResources(bundle.sourceSelectorType, sourceItems);
    if (items) onUpdate("source_variants", JSON.stringify(items));
  };
  const chooseTarget = async () => {
    const items = await pickResources(bundle.targetSelectorType, targetItems);
    if (items) onUpdate("target_variants", JSON.stringify(items));
  };
  const removeItem = (field: "source_variants" | "target_variants", items: Item[], id: string, isProduct: boolean) =>
    onUpdate(field, JSON.stringify(items.filter((i) => (isProduct ? i.productId : i.variantId) !== id)));

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Offer {bundleIndex + 1}</s-heading>
          {allBundles.length > 1 ? (
            <s-button variant="tertiary" tone="critical" onClick={onRemove}>Remove</s-button>
          ) : null}
        </s-stack>

        {renderRules ? (
        <>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-select label="Discount type" value={bundle.operator}
            onChange={(e: Event) => onUpdate("operator", (e.currentTarget as HTMLSelectElement).value)}>
            <s-option value="percentage">Percentage off</s-option>
            <s-option value="amount">Fixed amount off</s-option>
          </s-select>
          <s-number-field label={isPercentage ? "Discount percentage" : "Discount amount"}
            value={bundle.value} min={0} max={isPercentage ? 100 : undefined} suffix={isPercentage ? "%" : "$"}
            onChange={(e: Event) => onUpdate("value", (e.currentTarget as HTMLInputElement).value)} />
          <s-select label="Discount from" details="Choose which price the discount is taken off." value={bundle.apply_to}
            onChange={(e: Event) => onUpdate("apply_to", (e.currentTarget as HTMLSelectElement).value)}>
            <s-option value="price">Selling price</s-option>
            <s-option value="compare_at_price">Original (compare-at) price</s-option>
          </s-select>
          <s-select label="If several products qualify" value={bundle.selectionStrategy}
            onChange={(e: Event) => onUpdate("selectionStrategy", (e.currentTarget as HTMLSelectElement).value)}>
            <s-option value="ALL">Discount them all</s-option>
            <s-option value="FIRST">Discount the first one</s-option>
            <s-option value="MAXIMUM">Discount the best-value one</s-option>
          </s-select>
        </s-grid>
        <s-text-field label="Message shown to shoppers" placeholder="e.g. 20% off" value={bundle.message}
          onChange={(e: Event) => onUpdate("message", (e.currentTarget as HTMLInputElement).value)} />

        <s-checkbox checked={bundle.quantity_dependent}
          onChange={(e: Event) => onUpdate("quantity_dependent", (e.currentTarget as HTMLInputElement).checked)}
          label="Limit how many items are discounted" />
        {bundle.quantity_dependent ? (
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-number-field label="Minimum quantity to buy" placeholder="No minimum" value={bundle.min_qty} min={0}
              onChange={(e: Event) => onUpdate("min_qty", (e.currentTarget as HTMLInputElement).value)} />
            <s-number-field label="Discounted items per qualifying item" value={bundle.target_per_source} min={1}
              onChange={(e: Event) => onUpdate("target_per_source", (e.currentTarget as HTMLInputElement).value)} />
            <s-checkbox checked={bundle.fixed_ratios}
              onChange={(e: Event) => onUpdate("fixed_ratios", (e.currentTarget as HTMLInputElement).checked)}
              label="Require exact sets" />
            <s-checkbox checked={bundle.shared_pool}
              onChange={(e: Event) => onUpdate("shared_pool", (e.currentTarget as HTMLInputElement).checked)}
              label="Share the discount limit across products" />
            <s-number-field label="Maximum discounted items" placeholder="Optional" value={bundle.max_target_qty} min={1}
              disabled={!bundle.fixed_ratios}
              onChange={(e: Event) => onUpdate("max_target_qty", (e.currentTarget as HTMLInputElement).value)} />
          </s-grid>
        ) : (
          <s-number-field label="Minimum quantity to buy" placeholder="No minimum" value={bundle.min_qty} min={0}
            onChange={(e: Event) => onUpdate("min_qty", (e.currentTarget as HTMLInputElement).value)} />
        )}
        </>
        ) : null}

        {renderProducts ? (
        <>
        <s-heading>Products the shopper must buy</s-heading>
        <s-select label="Match products by" value={bundle.sourceSelectorType}
          onChange={(e: Event) => {
            const next = (e.currentTarget as HTMLSelectElement).value as SelectorType;
            if (next !== bundle.sourceSelectorType) { onUpdate("sourceSelectorType", next); onUpdate("source_variants", "[]"); }
          }}>
          <s-option value="variant_id">Specific variants</s-option>
          <s-option value="product_id">Whole products</s-option>
        </s-select>
        <s-button onClick={chooseSource}>Choose qualifying products</s-button>
        <SelectedResources
          items={sourceItems}
          selectorType={bundle.sourceSelectorType}
          label="Chosen products"
          onRemove={(id) => removeItem("source_variants", sourceItems, id, sourceIsProduct)}
        />

        <s-divider />
        <s-heading>Products that get the discount</s-heading>
        <s-select label="Match products by" value={bundle.targetSelectorType}
          onChange={(e: Event) => {
            const next = (e.currentTarget as HTMLSelectElement).value as SelectorType;
            if (next !== bundle.targetSelectorType) { onUpdate("targetSelectorType", next); onUpdate("target_variants", "[]"); }
          }}>
          <s-option value="variant_id">Specific variants</s-option>
          <s-option value="product_id">Whole products</s-option>
        </s-select>
        <s-button onClick={chooseTarget}>Choose discounted products</s-button>
        <SelectedResources
          items={targetItems}
          selectorType={bundle.targetSelectorType}
          label="Discounted products"
          onRemove={(id) => removeItem("target_variants", targetItems, id, targetIsProduct)}
        />
        </>
        ) : null}
      </s-stack>
    </s-box>
  );
}
