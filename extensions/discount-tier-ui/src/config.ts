// Pure config logic for the tier discount authoring UI. Framework-independent
// and unit-testable. Emits exactly the snake_case JSON the E2 `discount-tier`
// Rust serde contract parses ($app:discount-tier / config).

export const METAFIELD_NAMESPACE = "$app:discount-tier";
export const METAFIELD_KEY = "config";
export const METAFIELD_MAX_SIZE_BYTES = 10 * 1024;

export type SelectorType = "variant_id" | "product_id";
export type DiscountType = "percentage" | "amount";
export type ApplyTo = "price" | "compare_at_price";
export type SelectionStrategy = "ALL" | "FIRST" | "MAXIMUM";
export type Platform = "BOTH" | "POS" | "CHECKOUT";

/** A picked product/variant. Persisted verbatim as `targets_full` (UI-only). */
export interface TierItem {
  productId?: string;
  variantId?: string;
  productTitle?: string;
  variantTitle?: string;
  sku?: string;
}

export interface Tier {
  id: string;
  /** Discount magnitude; also the `discount_tiers` object key. */
  value: string;
  selectorType: SelectorType;
  /** JSON-encoded TierItem[] (kept as a string for the s-text-field dirty-tracking). */
  targets: string;
  /** Per-line minimum quantity; empty string = none. */
  min_qty: string;
}

export interface TierFormData {
  message: string;
  applyTo: ApplyTo;
  discountType: DiscountType;
  productDiscountSelectionStrategy: SelectionStrategy;
  platform: Platform;
  tiers: Tier[];
}

interface TierEntryOut {
  product_selector_type: SelectorType;
  targets: number[];
  targets_full: TierItem[];
  min_qty?: number;
}

export interface TierConfigOut {
  rule_type: "tier-discount";
  message: string;
  apply_to: ApplyTo;
  discount_type: DiscountType;
  product_discount_selection_strategy: SelectionStrategy;
  platform: Platform;
  discount_tiers: Record<string, TierEntryOut>;
}

function parseItems(targets: string): TierItem[] {
  try {
    const v = JSON.parse(targets || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Build the metafield JSON — numeric IDs only in `targets`, display objects in `targets_full`. */
export function buildTierConfig(formData: TierFormData): TierConfigOut {
  const discount_tiers: Record<string, TierEntryOut> = {};

  for (const tier of formData.tiers) {
    if (!tier.targets || !tier.targets.trim()) continue;
    const items = parseItems(tier.targets);
    if (items.length === 0) continue;

    const selectorType: SelectorType = tier.selectorType || "variant_id";
    const isProductId = selectorType === "product_id";
    const ids = (isProductId ? items.map((i) => i.productId) : items.map((i) => i.variantId))
      .filter((x): x is string => Boolean(x))
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    if (ids.length === 0) continue;

    const tierKey = tier.value;
    const minQty = tier.min_qty !== "" && tier.min_qty != null ? parseInt(tier.min_qty, 10) : 0;

    const entry: TierEntryOut = {
      product_selector_type: selectorType,
      targets: ids,
      targets_full: items,
      ...(minQty > 0 ? { min_qty: minQty } : {}),
    };

    const existing = discount_tiers[tierKey];
    if (existing) {
      existing.targets = [...new Set([...existing.targets, ...ids])];
      const keyField = isProductId ? "productId" : "variantId";
      const map = new Map(existing.targets_full.map((i) => [i[keyField], i]));
      for (const i of items) map.set(i[keyField], i);
      existing.targets_full = [...map.values()];
      if (minQty > 0) existing.min_qty = minQty;
    } else {
      discount_tiers[tierKey] = entry;
    }
  }

  return {
    rule_type: "tier-discount",
    message: formData.message,
    apply_to: formData.applyTo,
    discount_type: formData.discountType,
    product_discount_selection_strategy: formData.productDiscountSelectionStrategy,
    platform: formData.platform,
    discount_tiers,
  };
}

export function validateTierConfig(formData: TierFormData): string[] {
  const errors: string[] = [];
  const { discountType, platform, tiers } = formData;
  if (!discountType) errors.push("Discount Type is required for tier discount.");
  if (!platform) errors.push("Platform is required for tier discount.");
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push("At least one discount tier is required.");
  } else {
    tiers.forEach((tier, index) => {
      if (tier.value == null || String(tier.value).trim() === "") {
        errors.push(`Tier ${index + 1}: Discount percentage/amount is required.`);
      }
      if (parseItems(tier.targets).length === 0) {
        errors.push(`Tier ${index + 1}: At least one product or variant must be selected.`);
      }
    });
  }
  return errors;
}

export function getMetafieldValueString(formData: TierFormData): string {
  try {
    return JSON.stringify(buildTierConfig(formData));
  } catch {
    return "{}";
  }
}

export function getMetafieldSizeBytes(formData: TierFormData): number {
  return new TextEncoder().encode(getMetafieldValueString(formData)).length;
}

export function validateMetafieldSize(valueStr: string): void {
  const sizeBytes = new TextEncoder().encode(valueStr).length;
  if (sizeBytes > METAFIELD_MAX_SIZE_BYTES) {
    throw new Error(
      `Discount configuration is too large (${(sizeBytes / 1024).toFixed(1)}KB). Maximum size is 10KB. Please reduce the number of tiers.`,
    );
  }
}

/** Parse the stored metafield JSON back into editable form state. */
export function parseMetafield(value: string | undefined): TierFormData {
  const empty: TierFormData = {
    message: "",
    applyTo: "price",
    discountType: "percentage",
    productDiscountSelectionStrategy: "ALL",
    platform: "BOTH",
    tiers: [newTier()],
  };
  try {
    const parsed = JSON.parse(value || "{}");
    const rawTiers = parsed.discount_tiers ?? {};
    const tiers: Tier[] = Object.entries(rawTiers).map(([key, entry], index) => {
      const e = entry as Partial<TierEntryOut>;
      const minQty = e.min_qty;
      return {
        id: `tier-${index}-${key}`,
        value: key,
        selectorType: (e.product_selector_type as SelectorType) || "variant_id",
        targets: JSON.stringify(e.targets_full ?? []),
        min_qty: minQty != null && minQty !== 0 ? String(minQty) : "",
      };
    });
    return {
      message: parsed.message ?? "",
      applyTo: (parsed.apply_to as ApplyTo) ?? "price",
      discountType: (parsed.discount_type as DiscountType) ?? "percentage",
      productDiscountSelectionStrategy:
        (parsed.product_discount_selection_strategy as SelectionStrategy) ?? "ALL",
      platform: (parsed.platform as Platform) ?? "BOTH",
      tiers: tiers.length > 0 ? tiers : [newTier()],
    };
  } catch {
    return empty;
  }
}

let tierCounter = 0;
export function newTier(): Tier {
  tierCounter += 1;
  return {
    id: `tier-new-${tierCounter}`,
    value: "0",
    selectorType: "variant_id",
    targets: "[]",
    min_qty: "",
  };
}
