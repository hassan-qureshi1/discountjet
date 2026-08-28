import { useMemo } from "preact/hooks";
import type { DiscountType, SelectorType, Tier, TierItem } from "./config";
import { SelectedResources } from "./SelectedResources";

interface TierCardProps {
  tier: Tier;
  tierIndex: number;
  discountType: DiscountType;
  allTiers: Tier[];
  onUpdate: (field: keyof Tier, value: string) => void;
  onRemove: () => void;
}

function parseItems(targets: string): TierItem[] {
  try {
    const v = JSON.parse(targets || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const numericId = (gid: string): string => gid.split("/").pop() ?? "";

export function TierCard({
  tier,
  tierIndex,
  discountType,
  allTiers,
  onUpdate,
  onRemove,
}: TierCardProps) {
  const selectorType: SelectorType = tier.selectorType || "variant_id";
  const isProductSelector = selectorType === "product_id";
  const selectedItems = useMemo(() => parseItems(tier.targets), [tier.targets]);

  // Variants already chosen in OTHER tiers — prevents cross-tier duplication.
  const excludedVariantIds = useMemo(() => {
    const set = new Set<string>();
    for (const other of allTiers) {
      if (other.id === tier.id || other.selectorType === "product_id") continue;
      for (const it of parseItems(other.targets)) {
        if (it.variantId) set.add(it.variantId);
      }
    }
    return set;
  }, [allTiers, tier.id]);

  const handleSelectResources = async () => {
    try {
      if (isProductSelector) {
        const selectionIds = selectedItems
          .filter((p) => p.productId)
          .map((p) => ({ id: `gid://shopify/Product/${p.productId}` }));
        const selection = (await shopify.resourcePicker({
          type: "product",
          multiple: true,
          action: "select",
          filter: { variants: false, draft: false, archived: false },
          selectionIds,
        })) as Array<{ id: string; title?: string }> | undefined;
        if (!selection) return;
        const map = new Map<string, TierItem>();
        for (const product of selection) {
          const productId = numericId(product.id);
          if (!productId) continue;
          map.set(productId, { productId, productTitle: product.title ?? "" });
        }
        onUpdate("targets", JSON.stringify([...map.values()]));
      } else {
        const selectionIds = selectedItems
          .filter((v) => v.variantId)
          .map((v) => ({ id: `gid://shopify/ProductVariant/${v.variantId}` }));
        const selection = (await shopify.resourcePicker({
          type: "product",
          multiple: true,
          action: "select",
          filter: { variants: true, draft: false, archived: false },
          selectionIds,
        })) as
          | Array<{
              id: string;
              title?: string;
              variants?: Array<{ id: string; title?: string; sku?: string }>;
            }>
          | undefined;
        if (!selection) return;
        const map = new Map<string, TierItem>();
        for (const product of selection) {
          const productId = numericId(product.id);
          for (const variant of product.variants ?? []) {
            const variantId = numericId(variant.id);
            if (!productId || !variantId) continue;
            if (excludedVariantIds.has(variantId)) continue;
            map.set(variantId, {
              productId,
              variantId,
              productTitle: product.title ?? "",
              variantTitle: variant.title ?? "",
              sku: variant.sku ?? "",
            });
          }
        }
        onUpdate("targets", JSON.stringify([...map.values()]));
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error selecting resources:", error);
    }
  };

  const removeItem = (id: string) => {
    const next = selectedItems.filter((i) => (isProductSelector ? i.productId : i.variantId) !== id);
    onUpdate("targets", JSON.stringify(next));
  };

  const valueLabel = discountType === "amount" ? "Discount amount" : "Discount percentage";
  const valueSuffix = discountType === "amount" ? "$" : "%";

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Savings level {tierIndex + 1}</s-heading>
          {allTiers.length > 1 ? (
            <s-button variant="tertiary" tone="critical" onClick={onRemove}>
              Remove
            </s-button>
          ) : null}
        </s-stack>

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-number-field
            label={valueLabel}
            value={tier.value}
            min={0}
            max={discountType === "amount" ? undefined : 100}
            suffix={valueSuffix}
            onChange={(e: Event) =>
              onUpdate("value", (e.currentTarget as HTMLInputElement).value)
            }
          />
          <s-number-field
            label="Minimum quantity to unlock"
            placeholder="No minimum"
            details="How many of these products a shopper needs before this level applies."
            value={tier.min_qty}
            min={0}
            onChange={(e: Event) =>
              onUpdate("min_qty", (e.currentTarget as HTMLInputElement).value)
            }
          />
        </s-grid>

        <s-select
          label="Match products by"
          details="Match specific variants (e.g. one size/colour) or the whole product across all its variants."
          value={selectorType}
          onChange={(e: Event) => {
            const next = (e.currentTarget as HTMLSelectElement).value as SelectorType;
            if (next !== selectorType) {
              onUpdate("selectorType", next);
              onUpdate("targets", "[]");
            }
          }}
        >
          <s-option value="variant_id">Specific variants</s-option>
          <s-option value="product_id">Whole products</s-option>
        </s-select>

        <s-button onClick={handleSelectResources}>Choose products</s-button>

        <SelectedResources
          items={selectedItems}
          selectorType={selectorType}
          onRemove={removeItem}
          label="Chosen products"
        />
      </s-stack>
    </s-box>
  );
}
