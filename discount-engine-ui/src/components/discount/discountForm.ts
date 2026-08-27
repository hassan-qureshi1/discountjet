// Faithful port of the real discount-ui extension's form model
// (extensions/discount-ui). Where the extension calls shopify.resourcePicker,
// this standalone version picks from a small sample catalogue instead.

export type RuleType = 'tier-discount' | 'bundle-discount' | 'special_discount';
export type SelectorType = 'variant_id' | 'product_id';
export type Operator = 'percentage' | 'amount';
export type ApplyTo = 'price' | 'compare_at_price';
export type Platform = 'BOTH' | 'POS' | 'CHECKOUT';
export type Strategy = 'ALL' | 'FIRST' | 'MAXIMUM';

export interface VariantItem {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
}
export interface ProductItem {
  productId: string;
  productTitle: string;
}

export interface Tier {
  id: string;
  value: string;
  selectorType: SelectorType;
  /** JSON string of VariantItem[] or ProductItem[]. */
  targets: string;
  min_qty: string;
}

export interface BundleDiscount {
  id: string;
  source_variants: string;
  target_variants: string;
  sourceSelectorType: SelectorType;
  targetSelectorType: SelectorType;
  operator: Operator;
  value: string;
  message: string;
  apply_to: ApplyTo;
  min_qty: string;
  quantity_dependent: boolean;
  target_per_source: string;
  fixed_ratios: boolean;
  max_target_qty: string;
  shared_pool: boolean;
  selectionStrategy: Strategy;
}

export interface SpecialTarget {
  targetSelectorType: SelectorType;
  target_variants: string;
  target_operator: Operator;
  target_value: string;
  target_message: string;
}

export interface SpecialDiscount {
  id: string;
  source_variants: string;
  sourceSelectorType: SelectorType;
  source_operator: Operator;
  source_value: string;
  source_message: string;
  message: string;
  apply_to: ApplyTo;
  min_qty: string;
  quantity_dependent: boolean;
  target_per_source: string;
  fixed_ratios: boolean;
  shared_pool: boolean;
  selectionStrategy: Strategy;
  targets: SpecialTarget[];
}

export interface FormData {
  ruleType: RuleType;
  discountType: Operator;
  applyTo: ApplyTo;
  productDiscountSelectionStrategy: Strategy;
  platform: Platform;
  message: string;
  tiers: Tier[];
  bundleDiscounts: BundleDiscount[];
  specialDiscounts: SpecialDiscount[];
}

export const METAFIELD_MAX_SIZE_BYTES = 10 * 1024;

// ─── Sample catalogue (stands in for shopify.resourcePicker) ─────────────────
export const SAMPLE_VARIANTS: VariantItem[] = [
  { productId: '101', variantId: '201', productTitle: 'Memory Foam Pillow', variantTitle: 'Standard', sku: 'MFP-STD' },
  { productId: '101', variantId: '202', productTitle: 'Memory Foam Pillow', variantTitle: 'King', sku: 'MFP-KING' },
  { productId: '102', variantId: '203', productTitle: 'Bamboo Sheet Set', variantTitle: 'Queen', sku: 'BSS-Q' },
  { productId: '103', variantId: '204', productTitle: 'Oak Bed Frame', variantTitle: 'Queen', sku: 'OBF-Q' },
  { productId: '104', variantId: '205', productTitle: 'Mattress Protector', variantTitle: 'Queen', sku: 'MP-Q' },
];

export const SAMPLE_PRODUCTS: ProductItem[] = [
  { productId: '101', productTitle: 'Memory Foam Pillow' },
  { productId: '102', productTitle: 'Bamboo Sheet Set' },
  { productId: '103', productTitle: 'Oak Bed Frame' },
  { productId: '104', productTitle: 'Mattress Protector' },
];

export function parseItems<T>(json: string): T[] {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}

/** Append the next sample item not already chosen — simulates the picker. */
export function pickNext(currentJson: string, selectorType: SelectorType): string {
  if (selectorType === 'product_id') {
    const current = parseItems<ProductItem>(currentJson);
    const chosen = new Set(current.map((p) => p.productId));
    const next = SAMPLE_PRODUCTS.find((p) => !chosen.has(p.productId));
    return JSON.stringify(next ? [...current, next] : current);
  }
  const current = parseItems<VariantItem>(currentJson);
  const chosen = new Set(current.map((v) => v.variantId));
  const next = SAMPLE_VARIANTS.find((v) => !chosen.has(v.variantId));
  return JSON.stringify(next ? [...current, next] : current);
}

export function chipLabel(item: VariantItem | ProductItem): string {
  if ('variantId' in item) {
    return item.sku
      ? `${item.productTitle} - ${item.sku}`
      : `${item.productTitle} - ${item.variantTitle || item.variantId}`;
  }
  return item.productTitle || item.productId;
}

/** A representative product image (emoji) for a product/variant title. */
export function emojiForTitle(title: string): string {
  const t = (title || '').toLowerCase();
  if (t.includes('pillow')) return '🛌';
  if (t.includes('duvet') || t.includes('sheet')) return '🧺';
  if (t.includes('protector')) return '🛡️';
  if (t.includes('bed frame') || t.includes('mattress')) return '🛏️';
  if (t.includes('sofa')) return '🛋️';
  if (t.includes('cushion')) return '🪟';
  if (t.includes('throw')) return '🧣';
  return '📦';
}

/** A representative product image (emoji) for a chosen product/variant. */
export function productEmoji(item: VariantItem | ProductItem): string {
  return emojiForTitle(item.productTitle || '');
}

export function itemKey(item: VariantItem | ProductItem): string {
  return 'variantId' in item ? item.variantId : item.productId;
}

// ─── Factories ───────────────────────────────────────────────────────────────
let seq = 0;
const uid = (prefix: string) => `${prefix}-${(seq += 1)}`;

export const newTier = (): Tier => ({
  id: uid('tier'),
  value: '0',
  selectorType: 'variant_id',
  targets: '[]',
  min_qty: '',
});

export const newBundle = (): BundleDiscount => ({
  id: uid('bundle'),
  source_variants: '[]',
  target_variants: '[]',
  sourceSelectorType: 'variant_id',
  targetSelectorType: 'variant_id',
  operator: 'percentage',
  value: '0',
  message: '',
  apply_to: 'price',
  min_qty: '',
  quantity_dependent: false,
  target_per_source: '1',
  fixed_ratios: false,
  max_target_qty: '',
  shared_pool: true,
  selectionStrategy: 'ALL',
});

export const newSpecialTarget = (): SpecialTarget => ({
  targetSelectorType: 'variant_id',
  target_variants: '[]',
  target_operator: 'percentage',
  target_value: '0',
  target_message: '',
});

export const newSpecial = (): SpecialDiscount => ({
  id: uid('special'),
  source_variants: '[]',
  sourceSelectorType: 'variant_id',
  source_operator: 'percentage',
  source_value: '0',
  source_message: '',
  message: '',
  apply_to: 'price',
  min_qty: '',
  quantity_dependent: false,
  target_per_source: '1',
  fixed_ratios: false,
  shared_pool: true,
  selectionStrategy: 'ALL',
  targets: [newSpecialTarget()],
});

export const createInitialFormData = (ruleType: RuleType = 'tier-discount', prefill = false): FormData => {
  const base = {
    ruleType,
    discountType: 'percentage' as Operator,
    applyTo: 'price' as ApplyTo,
    productDiscountSelectionStrategy: 'ALL' as Strategy,
    platform: 'BOTH' as Platform,
    message: prefill ? 'Buy more, save more' : '',
  };

  // Editing an existing discount: seed the wizard with sample products + values
  // so it opens showing predefined data rather than an empty form.
  if (prefill && ruleType === 'bundle-discount') {
    return {
      ...base,
      tiers: [newTier()],
      bundleDiscounts: [
        {
          ...newBundle(),
          source_variants: JSON.stringify(SAMPLE_VARIANTS.slice(0, 1)),
          target_variants: JSON.stringify(SAMPLE_VARIANTS.slice(1, 2)),
          value: '20',
          message: '20% off',
        },
      ],
      specialDiscounts: [],
    };
  }
  if (prefill && ruleType === 'special_discount') {
    return {
      ...base,
      tiers: [newTier()],
      bundleDiscounts: [],
      specialDiscounts: [
        {
          ...newSpecial(),
          source_variants: JSON.stringify(SAMPLE_VARIANTS.slice(0, 1)),
          source_value: '15',
          message: '15% off',
          targets: [{ ...newSpecialTarget(), target_variants: JSON.stringify(SAMPLE_VARIANTS.slice(1, 2)), target_value: '50' }],
        },
      ],
    };
  }

  return {
    ...base,
    tiers: [
      prefill
        ? { ...newTier(), value: '15', min_qty: '2', targets: JSON.stringify(SAMPLE_VARIANTS.slice(0, 2)) }
        : newTier(),
    ],
    bundleDiscounts: ruleType === 'bundle-discount' ? [newBundle()] : [],
    specialDiscounts: ruleType === 'special_discount' ? [newSpecial()] : [],
  };
};

// ─── Wizard step labels per offer type (always 4 steps) ──────────────────────
export const STEP_LABELS: Record<RuleType, string[]> = {
  'tier-discount': ['Offer type', 'Discount', 'Savings levels', 'Review'],
  'bundle-discount': ['Offer type', 'Products', 'Discount & rules', 'Review'],
  special_discount: ['Offer type', 'Products', 'Discount & rules', 'Review'],
};

// ─── Labels used by the review summary ───────────────────────────────────────
export const discountPhrase = (operator: Operator, value: string | number) => {
  const v = value ?? 0;
  return operator === 'percentage' ? `${v}% off` : `$${v} off`;
};
export const applyFromLabel = (applyTo: ApplyTo) =>
  applyTo === 'compare_at_price' ? 'original (compare-at) price' : 'selling price';
export const platformLabel = (platform: Platform) =>
  platform === 'POS'
    ? 'In person only (POS)'
    : platform === 'CHECKOUT'
      ? 'Online store only'
      : 'Online store & in person (POS)';
export const strategyLabel = (strategy: Strategy) =>
  strategy === 'FIRST'
    ? 'the first qualifying product'
    : strategy === 'MAXIMUM'
      ? 'the best-value product'
      : 'every qualifying product';

// ─── Validation (mirrors useExtensionData validators) ────────────────────────
export function validate(formData: FormData): string[] {
  const errors: string[] = [];
  if (formData.ruleType === 'tier-discount') {
    formData.tiers.forEach((tier, i) => {
      if (!tier.value || String(tier.value).trim() === '')
        errors.push(`Tier ${i + 1}: Discount percentage/amount is required.`);
      if (parseItems(tier.targets).length === 0)
        errors.push(`Tier ${i + 1}: At least one product or variant must be selected.`);
    });
  } else if (formData.ruleType === 'bundle-discount') {
    formData.bundleDiscounts.forEach((b, i) => {
      if (parseItems(b.source_variants).length === 0)
        errors.push(`Bundle ${i + 1}: At least one qualifying product is required.`);
      if (parseItems(b.target_variants).length === 0)
        errors.push(`Bundle ${i + 1}: At least one discounted product is required.`);
      if (!b.message.trim()) errors.push(`Bundle ${i + 1}: Message is required.`);
    });
  } else {
    formData.specialDiscounts.forEach((s, i) => {
      if (parseItems(s.source_variants).length === 0)
        errors.push(`Special ${i + 1}: At least one qualifying product is required.`);
      const hasTarget = s.targets.some((t) => parseItems(t.target_variants).length > 0);
      if (!hasTarget) errors.push(`Special ${i + 1}: Each target must have at least one product.`);
      if (!s.message.trim()) errors.push(`Special ${i + 1}: Message is required.`);
    });
  }
  return errors;
}

/** Rough byte size of the serialized config, for the metafield-size banner. */
export function metafieldSizeBytes(formData: FormData): number {
  return new TextEncoder().encode(JSON.stringify(formData)).length;
}
