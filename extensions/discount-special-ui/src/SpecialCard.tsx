import { useMemo } from "preact/hooks";
import type { Item, SelectorType, Special, TargetGroup } from "./config";
import { newTarget, parseItems } from "./config";
import { SelectedResources } from "./SelectedResources";

interface Props {
  special: Special;
  specialIndex: number;
  allSpecials: Special[];
  onUpdate: (field: keyof Special, value: string | boolean | TargetGroup[]) => void;
  onRemove: () => void;
  /** Which slice of the card to render. Omit to render everything (default). */
  section?: "products" | "rules";
}

const numericId = (gid: string): string => gid.split("/").pop() ?? "";

async function pickResources(selectorType: SelectorType, current: Item[]): Promise<Item[] | null> {
  const isProduct = selectorType === "product_id";
  if (isProduct) {
    const selectionIds = current.filter((p) => p.productId).map((p) => ({ id: `gid://shopify/Product/${p.productId}` }));
    const selection = (await shopify.resourcePicker({
      type: "product", multiple: true, action: "select",
      filter: { variants: false, draft: false, archived: false }, selectionIds,
    })) as Array<{ id: string; title?: string }> | undefined;
    if (!selection) return null;
    const map = new Map<string, Item>();
    for (const p of selection) {
      const productId = numericId(p.id);
      if (productId) map.set(productId, { productId, productTitle: p.title ?? "" });
    }
    return [...map.values()];
  }
  const selectionIds = current.filter((v) => v.variantId).map((v) => ({ id: `gid://shopify/ProductVariant/${v.variantId}` }));
  const selection = (await shopify.resourcePicker({
    type: "product", multiple: true, action: "select",
    filter: { variants: true, draft: false, archived: false }, selectionIds,
  })) as Array<{ id: string; title?: string; variants?: Array<{ id: string; title?: string; sku?: string }> }> | undefined;
  if (!selection) return null;
  const map = new Map<string, Item>();
  for (const p of selection) {
    const productId = numericId(p.id);
    for (const v of p.variants ?? []) {
      const variantId = numericId(v.id);
      if (productId && variantId) {
        map.set(variantId, { productId, variantId, productTitle: p.title ?? "", variantTitle: v.title ?? "", sku: v.sku ?? "" });
      }
    }
  }
  return [...map.values()];
}

export function SpecialCard({ special, specialIndex, allSpecials, onUpdate, onRemove, section }: Props) {
  const sourceItems = useMemo(() => parseItems(special.source_variants), [special.source_variants]);
  const sourceIsProduct = special.sourceSelectorType === "product_id";
  const isPct = special.source_operator === "percentage";
  const renderProducts = !section || section === "products";
  const renderRules = !section || section === "rules";

  const chooseSource = async () => {
    const items = await pickResources(special.sourceSelectorType, sourceItems);
    if (items) onUpdate("source_variants", JSON.stringify(items));
  };
  const removeSource = (id: string) =>
    onUpdate("source_variants", JSON.stringify(sourceItems.filter((i) => (sourceIsProduct ? i.productId : i.variantId) !== id)));

  const updateTarget = (ti: number, field: keyof TargetGroup, value: string) =>
    onUpdate("targets", special.targets.map((t, i) => (i === ti ? { ...t, [field]: value } : t)));
  const addTarget = () => onUpdate("targets", [...special.targets, newTarget()]);
  const removeTarget = (ti: number) => onUpdate("targets", special.targets.filter((_, i) => i !== ti));

  const chooseTarget = async (ti: number, t: TargetGroup) => {
    const items = await pickResources(t.targetSelectorType, parseItems(t.target_variants));
    if (items) updateTarget(ti, "target_variants", JSON.stringify(items));
  };

  // Switching match mode must change the selector AND clear the now-invalid items
  // in a single update, or the second change would overwrite the first.
  const changeTargetSelector = (ti: number, next: SelectorType) =>
    onUpdate(
      "targets",
      special.targets.map((t, i) => (i === ti ? { ...t, targetSelectorType: next, target_variants: "[]" } : t)),
    );

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Offer {specialIndex + 1}</s-heading>
          {allSpecials.length > 1 && renderProducts ? (
            <s-button variant="tertiary" tone="critical" onClick={onRemove}>Remove</s-button>
          ) : null}
        </s-stack>

        {renderRules ? (
          <>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select label="Discount from" details="Choose which price the discount is taken off." value={special.apply_to}
                onChange={(e: Event) => onUpdate("apply_to", (e.currentTarget as HTMLSelectElement).value)}>
                <s-option value="price">Selling price</s-option>
                <s-option value="compare_at_price">Original (compare-at) price</s-option>
              </s-select>
              <s-select label="If several products qualify" value={special.selectionStrategy}
                onChange={(e: Event) => onUpdate("selectionStrategy", (e.currentTarget as HTMLSelectElement).value)}>
                <s-option value="ALL">Discount them all</s-option>
                <s-option value="FIRST">Discount the first one</s-option>
                <s-option value="MAXIMUM">Discount the best-value one</s-option>
              </s-select>
            </s-grid>
            <s-text-field label="Message shown to shoppers" placeholder="e.g. 20% off" value={special.message}
              onChange={(e: Event) => onUpdate("message", (e.currentTarget as HTMLInputElement).value)} />

            <s-checkbox checked={special.quantity_dependent}
              onChange={(e: Event) => onUpdate("quantity_dependent", (e.currentTarget as HTMLInputElement).checked)}
              label="Limit how many items are discounted" />
            {special.quantity_dependent ? (
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-number-field label="Minimum quantity to buy" placeholder="No minimum" value={special.min_qty} min={0}
                  onChange={(e: Event) => onUpdate("min_qty", (e.currentTarget as HTMLInputElement).value)} />
                <s-number-field label="Discounted items per qualifying item" value={special.target_per_source} min={1}
                  onChange={(e: Event) => onUpdate("target_per_source", (e.currentTarget as HTMLInputElement).value)} />
                <s-checkbox checked={special.fixed_ratios}
                  onChange={(e: Event) => onUpdate("fixed_ratios", (e.currentTarget as HTMLInputElement).checked)}
                  label="Require exact sets" />
                <s-checkbox checked={special.shared_pool}
                  onChange={(e: Event) => onUpdate("shared_pool", (e.currentTarget as HTMLInputElement).checked)}
                  label="Share the discount limit across products" />
              </s-grid>
            ) : (
              <s-number-field label="Minimum quantity to buy" placeholder="No minimum" value={special.min_qty} min={0}
                onChange={(e: Event) => onUpdate("min_qty", (e.currentTarget as HTMLInputElement).value)} />
            )}

            <s-divider />
            <s-heading>Discount for the qualifying products</s-heading>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select label="Discount type" value={special.source_operator}
                onChange={(e: Event) => onUpdate("source_operator", (e.currentTarget as HTMLSelectElement).value)}>
                <s-option value="percentage">Percentage</s-option>
                <s-option value="amount">Amount</s-option>
              </s-select>
              <s-number-field label={isPct ? "Discount percentage" : "Discount amount"} value={special.source_value}
                min={0} max={isPct ? 100 : undefined} suffix={isPct ? "%" : "$"}
                onChange={(e: Event) => onUpdate("source_value", (e.currentTarget as HTMLInputElement).value)} />
            </s-grid>
            <s-text-field label="Message for these products" placeholder="e.g. Main item 20% off" value={special.source_message}
              onChange={(e: Event) => onUpdate("source_message", (e.currentTarget as HTMLInputElement).value)} />
          </>
        ) : null}

        {renderProducts ? (
          <>
            {renderRules ? <s-divider /> : null}
            <s-heading>Products the shopper must buy</s-heading>
            <s-select label="Match products by" value={special.sourceSelectorType}
              onChange={(e: Event) => {
                const next = (e.currentTarget as HTMLSelectElement).value as SelectorType;
                if (next !== special.sourceSelectorType) { onUpdate("sourceSelectorType", next); onUpdate("source_variants", "[]"); }
              }}>
              <s-option value="variant_id">Specific variants</s-option>
              <s-option value="product_id">Whole products</s-option>
            </s-select>
            <s-button onClick={chooseSource}>Choose qualifying products</s-button>
            <SelectedResources
              items={sourceItems}
              selectorType={special.sourceSelectorType}
              label="Chosen products"
              onRemove={removeSource}
            />
          </>
        ) : null}

        <s-divider />
        <s-heading>{renderProducts ? "Products that get the discount" : "Discounts for the unlocked products"}</s-heading>
        {special.targets.map((t, ti) => {
          const targetItems = parseItems(t.target_variants);
          const targetIsProduct = t.targetSelectorType === "product_id";
          const tPct = t.target_operator === "percentage";
          return (
            <s-box key={t.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                  <s-text>Discounted set {ti + 1}</s-text>
                  {special.targets.length > 1 && renderProducts ? (
                    <s-button variant="tertiary" tone="critical" onClick={() => removeTarget(ti)}>Remove</s-button>
                  ) : null}
                </s-stack>
                {renderRules ? (
                  <>
                    <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                      <s-select label="Discount type" value={t.target_operator}
                        onChange={(e: Event) => updateTarget(ti, "target_operator", (e.currentTarget as HTMLSelectElement).value)}>
                        <s-option value="percentage">Percentage</s-option>
                        <s-option value="amount">Amount</s-option>
                      </s-select>
                      <s-number-field label={tPct ? "Discount percentage" : "Discount amount"} value={t.target_value}
                        min={0} max={tPct ? 100 : undefined} suffix={tPct ? "%" : "$"}
                        onChange={(e: Event) => updateTarget(ti, "target_value", (e.currentTarget as HTMLInputElement).value)} />
                    </s-grid>
                    <s-text-field label="Message for these products" placeholder="e.g. Bonus item 30% off" value={t.target_message}
                      onChange={(e: Event) => updateTarget(ti, "target_message", (e.currentTarget as HTMLInputElement).value)} />
                  </>
                ) : null}
                {renderProducts ? (
                  <>
                    <s-select label="Match products by" value={t.targetSelectorType}
                      onChange={(e: Event) => {
                        const next = (e.currentTarget as HTMLSelectElement).value as SelectorType;
                        if (next !== t.targetSelectorType) changeTargetSelector(ti, next);
                      }}>
                      <s-option value="variant_id">Specific variants</s-option>
                      <s-option value="product_id">Whole products</s-option>
                    </s-select>
                    <s-button onClick={() => chooseTarget(ti, t)}>Choose discounted products</s-button>
                    <SelectedResources
                      items={targetItems}
                      selectorType={t.targetSelectorType}
                      label="Discounted products"
                      onRemove={(id) =>
                        updateTarget(ti, "target_variants", JSON.stringify(targetItems.filter((i) => (targetIsProduct ? i.productId : i.variantId) !== id)))
                      }
                    />
                  </>
                ) : null}
              </s-stack>
            </s-box>
          );
        })}
        {renderProducts ? <s-button onClick={addTarget}>Add another set</s-button> : null}
      </s-stack>
    </s-box>
  );
}
