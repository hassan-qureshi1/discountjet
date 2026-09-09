// Pure config logic for the bundle authoring UI. Emits the snake_case JSON the
// E2 `discount-bundle` Rust serde contract parses ($app:discount-bundle / config).

export const METAFIELD_NAMESPACE = "$app:discount-bundle";
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

export interface Bundle {
  id: string;
  sourceSelectorType: SelectorType;
  targetSelectorType: SelectorType;
  source_variants: string; // JSON Item[]
  target_variants: string; // JSON Item[]
  operator: Operator;
  value: string;
  message: string;
  apply_to: ApplyTo;
  quantity_dependent: boolean;
  min_qty: string;
  target_per_source: string;
  fixed_ratios: boolean;
  shared_pool: boolean;
  max_target_qty: string;
  selectionStrategy: SelectionStrategy;
}

export interface BundleFormData {
  platform: Platform;
  bundles: Bundle[];
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

export function buildBundleConfig(formData: BundleFormData) {
  const bundle_discounts = formData.bundles
    .map((b) => {
      const sourceItems = parseItems(b.source_variants);
      const targetItems = parseItems(b.target_variants);
      const sourceIsProduct = b.sourceSelectorType === "product_id";
      const targetIsProduct = b.targetSelectorType === "product_id";
      const sourceProductIds = ids(sourceItems, true);
      const targetProductIds = ids(targetItems, true);
      const quantityDependent = b.quantity_dependent === true;
      const minQty = b.min_qty !== "" && b.min_qty != null ? parseInt(b.min_qty, 10) : NaN;
      const targetPerSource = Math.max(1, parseInt(b.target_per_source, 10) || 1);
      const maxTargetQty =
        b.max_target_qty !== "" && b.max_target_qty != null
          ? Math.max(1, parseInt(b.max_target_qty, 10) || 1)
          : undefined;

      return {
        source_selector_type: b.sourceSelectorType || "variant_id",
        target_selector_type: b.targetSelectorType || "variant_id",
        source_variants: sourceIsProduct ? [] : ids(sourceItems, false),
        target_variants: targetIsProduct ? [] : ids(targetItems, false),
        source_variants_full: sourceItems,
        target_variants_full: targetItems,
        operator: b.operator || "percentage",
        value: parseFloat(b.value) || 0,
        message: b.message || "",
        apply_on: "target",
        apply_to: b.apply_to || "price",
        product_discount_selection_strategy: b.selectionStrategy || "ALL",
        quantity_dependent: quantityDependent,
        ...(quantityDependent ? { target_per_source: targetPerSource } : {}),
        fixed_ratios: b.fixed_ratios === true,
        ...(b.fixed_ratios === true && maxTargetQty != null ? { max_target_qty: maxTargetQty } : {}),
        ...(quantityDependent ? { shared_pool: b.shared_pool !== false } : {}),
        ...(!Number.isNaN(minQty) && minQty > 0 ? { min_qty: minQty } : {}),
        ...(sourceIsProduct && sourceProductIds.length > 0 ? { source_product_ids: sourceProductIds } : {}),
        ...(targetIsProduct && targetProductIds.length > 0 ? { target_product_ids: targetProductIds } : {}),
      };
    });

  return { rule_type: "bundle-discount", platform: formData.platform, bundle_discounts };
}

export function validateBundleConfig(formData: BundleFormData): string[] {
  const errors: string[] = [];
  if (!Array.isArray(formData.bundles) || formData.bundles.length === 0) {
    errors.push("At least one bundle configuration is required.");
    return errors;
  }
  formData.bundles.forEach((b, i) => {
    const n = i + 1;
    if (parseItems(b.source_variants).length === 0) {
      errors.push(`Bundle ${n}: At least one source product or variant is required.`);
    }
    if (parseItems(b.target_variants).length === 0) {
      errors.push(`Bundle ${n}: At least one target product or variant is required.`);
    }
    if (!b.operator) errors.push(`Bundle ${n}: Discount type (operator) is required.`);
    if (b.value == null || b.value === "" || Number.isNaN(parseFloat(b.value))) {
      errors.push(`Bundle ${n}: Discount value is required.`);
    }
    if (b.fixed_ratios === true && b.max_target_qty !== "" && b.max_target_qty != null) {
      const parsed = parseInt(b.max_target_qty, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        const tps = Math.max(1, parseInt(b.target_per_source, 10) || 1);
        const minQty = b.min_qty !== "" ? parseInt(b.min_qty, 10) : 0;
        if (parsed <= tps) errors.push(`Bundle ${n}: Max target qty must be greater than target per source (${tps}).`);
        else if (minQty > 0 && parsed <= minQty) errors.push(`Bundle ${n}: Max target qty must be greater than minimum quantity (${minQty}).`);
      }
    }
  });
  if (!formData.platform) errors.push("Platform is required.");
  return errors;
}

export function getMetafieldValueString(formData: BundleFormData): string {
  try {
    return JSON.stringify(buildBundleConfig(formData));
  } catch {
    return "{}";
  }
}

export function getMetafieldSizeBytes(formData: BundleFormData): number {
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

let counter = 0;
export function newBundle(): Bundle {
  counter += 1;
  return {
    id: `bundle-${counter}`,
    sourceSelectorType: "variant_id",
    targetSelectorType: "variant_id",
    source_variants: "[]",
    target_variants: "[]",
    operator: "percentage",
    value: "0",
    message: "",
    apply_to: "price",
    quantity_dependent: false,
    min_qty: "",
    target_per_source: "1",
    fixed_ratios: false,
    shared_pool: true,
    max_target_qty: "",
    selectionStrategy: "ALL",
  };
}

export function parseMetafield(value: string | undefined): BundleFormData {
  try {
    const parsed = JSON.parse(value || "{}");
    const rawBundles = Array.isArray(parsed.bundle_discounts) ? parsed.bundle_discounts : [];
    const bundles: Bundle[] = rawBundles.map((b: Record<string, unknown>, index: number) => {
      const sst = ((b.source_selector_type as SelectorType) || "variant_id");
      const tst = ((b.target_selector_type as SelectorType) || "variant_id");
      return {
        id: `bundle-${index}`,
        sourceSelectorType: sst,
        targetSelectorType: tst,
        source_variants: JSON.stringify(b.source_variants_full ?? []),
        target_variants: JSON.stringify(b.target_variants_full ?? []),
        operator: ((b.operator as Operator) || "percentage"),
        value: String(b.value ?? "0"),
        message: (b.message as string) ?? "",
        apply_to: ((b.apply_to as ApplyTo) || "price"),
        quantity_dependent: b.quantity_dependent === true,
        min_qty: b.min_qty != null ? String(b.min_qty) : "",
        target_per_source: b.target_per_source != null ? String(b.target_per_source) : "1",
        fixed_ratios: b.fixed_ratios === true,
        shared_pool: b.shared_pool !== false,
        max_target_qty: b.max_target_qty != null ? String(b.max_target_qty) : "",
        selectionStrategy: ((b.product_discount_selection_strategy as SelectionStrategy) || "ALL"),
      };
    });
    return {
      platform: ((parsed.platform as Platform) || "BOTH"),
      bundles: bundles.length > 0 ? bundles : [newBundle()],
    };
  } catch {
    return { platform: "BOTH", bundles: [newBundle()] };
  }
}
