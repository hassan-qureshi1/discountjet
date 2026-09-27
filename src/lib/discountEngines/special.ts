// Pure config logic for the special authoring UI. Emits the snake_case JSON the
// E2 `discount-special` Rust serde contract parses ($app:discount-special / config).

export const METAFIELD_NAMESPACE = "$app:discount-special";
export const METAFIELD_KEY = "config";
export const METAFIELD_MAX_SIZE_BYTES = 10 * 1024;

export type SelectorType = "variant_id" | "product_id";
export type Operator = "percentage" | "amount";
export type ApplyTo = "price" | "compare_at_price";
export type SelectionStrategy = "ALL" | "FIRST" | "MAXIMUM";
export type Platform = "BOTH" | "POS" | "CHECKOUT";

export interface Item {
  productId?: string;
  variantId?: string;
  productTitle?: string;
  variantTitle?: string;
  sku?: string;
}

export interface TargetGroup {
  id: string;
  targetSelectorType: SelectorType;
  target_variants: string; // JSON Item[]
  target_operator: Operator;
  target_value: string;
  target_message: string;
}

export interface Special {
  id: string;
  sourceSelectorType: SelectorType;
  source_variants: string; // JSON Item[]
  source_operator: Operator;
  source_value: string;
  source_message: string;
  apply_to: ApplyTo;
  message: string;
  quantity_dependent: boolean;
  min_qty: string;
  target_per_source: string;
  fixed_ratios: boolean;
  shared_pool: boolean;
  selectionStrategy: SelectionStrategy;
  targets: TargetGroup[];
}

export interface SpecialFormData {
  platform: Platform;
  specials: Special[];
}

export function parseItems(json: string): Item[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function ids(items: Item[], isProduct: boolean): number[] {
  return (isProduct ? items.map((i) => i.productId) : items.map((i) => i.variantId))
    .filter((x): x is string => Boolean(x))
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

export function buildSpecialConfig(formData: SpecialFormData) {
  const special_discounts = formData.specials.map((s) => {
    const sourceItems = parseItems(s.source_variants);
    const sourceIsProduct = s.sourceSelectorType === "product_id";
    const sourceProductIds = ids(sourceItems, true);
    const quantityDependent = s.quantity_dependent === true;
    const minQty = s.min_qty !== "" && s.min_qty != null ? parseInt(s.min_qty, 10) : NaN;
    const targetPerSource = Math.max(1, parseInt(s.target_per_source, 10) || 1);

    const targets = s.targets.map((t) => {
      const targetItems = parseItems(t.target_variants);
      const targetIsProduct = t.targetSelectorType === "product_id";
      const targetProductIds = ids(targetItems, true);
      return {
        target_selector_type: t.targetSelectorType || "variant_id",
        target_variants: targetIsProduct ? [] : ids(targetItems, false),
        target_variants_full: targetItems,
        ...(targetIsProduct && targetProductIds.length > 0 ? { target_product_ids: targetProductIds } : {}),
        target_operator: t.target_operator || "percentage",
        target_value: parseFloat(t.target_value) || 0,
        target_message: t.target_message || "",
      };
    });

    return {
      source_selector_type: s.sourceSelectorType || "variant_id",
      source_variants: sourceIsProduct ? [] : ids(sourceItems, false),
      source_variants_full: sourceItems,
      ...(sourceIsProduct && sourceProductIds.length > 0 ? { source_product_ids: sourceProductIds } : {}),
      source_operator: s.source_operator || "percentage",
      source_value: parseFloat(s.source_value) || 0,
      source_message: s.source_message || "",
      targets,
      message: s.message || "",
      apply_on: "target",
      apply_to: s.apply_to || "price",
      product_discount_selection_strategy: s.selectionStrategy || "ALL",
      quantity_dependent: quantityDependent,
      ...(quantityDependent ? { target_per_source: targetPerSource } : {}),
      fixed_ratios: s.fixed_ratios === true,
      ...(quantityDependent ? { shared_pool: s.shared_pool !== false } : {}),
      ...(!Number.isNaN(minQty) && minQty > 0 ? { min_qty: minQty } : {}),
    };
  });

  return { rule_type: "special_discount", platform: formData.platform, special_discounts };
}

export function validateSpecialConfig(formData: SpecialFormData): string[] {
  const errors: string[] = [];
  if (!Array.isArray(formData.specials) || formData.specials.length === 0) {
    errors.push("At least one special discount configuration is required.");
    return errors;
  }
  formData.specials.forEach((s, i) => {
    const n = i + 1;
    if (parseItems(s.source_variants).length === 0) {
      errors.push(`Special ${n}: At least one source product or variant is required.`);
    }
    if (!s.source_operator) errors.push(`Special ${n}: Discount type for the qualifying products is required.`);
    if (s.source_value == null || String(s.source_value).trim() === "" || Number.isNaN(parseFloat(s.source_value))) {
      errors.push(`Special ${n}: Discount value for the qualifying products is required.`);
    }
    if (!Array.isArray(s.targets) || s.targets.length === 0) {
      errors.push(`Special ${n}: At least one target is required.`);
    } else {
      const minItems = Math.min(...s.targets.map((t) => parseItems(t.target_variants).length));
      if (minItems === 0) errors.push(`Special ${n}: Each target must have at least one product or variant.`);
      s.targets.forEach((t, ti) => {
        const tn = ti + 1;
        if (!t.target_operator) errors.push(`Special ${n} · Discounted set ${tn}: Discount type is required.`);
        if (t.target_value == null || String(t.target_value).trim() === "" || Number.isNaN(parseFloat(t.target_value))) {
          errors.push(`Special ${n} · Discounted set ${tn}: Discount value is required.`);
        }
      });
    }
  });
  if (!formData.platform) errors.push("Platform is required.");
  return errors;
}

export function getMetafieldValueString(formData: SpecialFormData): string {
  try {
    return JSON.stringify(buildSpecialConfig(formData));
  } catch {
    return "{}";
  }
}

export function getMetafieldSizeBytes(formData: SpecialFormData): number {
  return new TextEncoder().encode(getMetafieldValueString(formData)).length;
}

export function validateMetafieldSize(valueStr: string): void {
  const sizeBytes = new TextEncoder().encode(valueStr).length;
  if (sizeBytes > METAFIELD_MAX_SIZE_BYTES) {
    throw new Error(
      `Discount configuration is too large (${(sizeBytes / 1024).toFixed(1)}KB). Maximum size is 10KB.`,
    );
  }
}

let targetCounter = 0;
export function newTarget(): TargetGroup {
  targetCounter += 1;
  return {
    id: `target-${targetCounter}`,
    targetSelectorType: "variant_id",
    target_variants: "[]",
    target_operator: "percentage",
    target_value: "0",
    target_message: "",
  };
}

let specialCounter = 0;
export function newSpecial(): Special {
  specialCounter += 1;
  return {
    id: `special-${specialCounter}`,
    sourceSelectorType: "variant_id",
    source_variants: "[]",
    source_operator: "percentage",
    source_value: "0",
    source_message: "",
    apply_to: "price",
    message: "",
    quantity_dependent: false,
    min_qty: "",
    target_per_source: "1",
    fixed_ratios: false,
    shared_pool: true,
    selectionStrategy: "ALL",
    targets: [newTarget()],
  };
}

export function parseMetafield(value: string | undefined): SpecialFormData {
  try {
    const parsed = JSON.parse(value || "{}");
    const rawSpecials = Array.isArray(parsed.special_discounts) ? parsed.special_discounts : [];
    const specials: Special[] = rawSpecials.map((s: Record<string, unknown>, index: number) => {
      const rawTargets = Array.isArray(s.targets) ? (s.targets as Record<string, unknown>[]) : [];
      const targets: TargetGroup[] = rawTargets.map((t, ti) => ({
        id: `target-${index}-${ti}`,
        targetSelectorType: ((t.target_selector_type as SelectorType) || "variant_id"),
        target_variants: JSON.stringify(t.target_variants_full ?? []),
        target_operator: ((t.target_operator as Operator) || "percentage"),
        target_value: String(t.target_value ?? "0"),
        target_message: (t.target_message as string) ?? "",
      }));
      return {
        id: `special-${index}`,
        sourceSelectorType: ((s.source_selector_type as SelectorType) || "variant_id"),
        source_variants: JSON.stringify(s.source_variants_full ?? []),
        source_operator: ((s.source_operator as Operator) || "percentage"),
        source_value: String(s.source_value ?? "0"),
        source_message: (s.source_message as string) ?? "",
        apply_to: ((s.apply_to as ApplyTo) || "price"),
        message: (s.message as string) ?? "",
        quantity_dependent: s.quantity_dependent === true,
        min_qty: s.min_qty != null ? String(s.min_qty) : "",
        target_per_source: s.target_per_source != null ? String(s.target_per_source) : "1",
        fixed_ratios: s.fixed_ratios === true,
        shared_pool: s.shared_pool !== false,
        selectionStrategy: ((s.product_discount_selection_strategy as SelectionStrategy) || "ALL"),
        targets: targets.length > 0 ? targets : [newTarget()],
      };
    });
    return {
      platform: ((parsed.platform as Platform) || "BOTH"),
      specials: specials.length > 0 ? specials : [newSpecial()],
    };
  } catch {
    return { platform: "BOTH", specials: [newSpecial()] };
  }
}
