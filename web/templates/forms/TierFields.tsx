// web/templates/forms/TierFields.tsx
//
// Form body for a `tier` template — the only engine with a Stage 1 form (see
// web/Pages/TemplateCreate.tsx). Fully controlled: the page owns `TierFormData`
// and this component only renders it and reports edits through `onChange`, the
// same contract as `web/components/ScheduleCard.tsx`.
import { useAppBridge } from '@shopify/app-bridge-react';
import {
  BlockStack, Button, Card, Divider, InlineStack, Select, Tag, Text, TextField,
} from '@shopify/polaris';
import {
  newTier,
  type ApplyTo, type DiscountType, type Platform, type Tier, type TierFormData, type TierItem,
} from '../../../src/lib/discountEngines/tier';
import { tierItemsFromPicker } from '../../lib/picker';
import { VariantLabel } from '../../components/VariantLabel';

const DISCOUNT_TYPE_OPTIONS: { label: string; value: DiscountType }[] = [
  { label: 'Percentage', value: 'percentage' },
  { label: 'Fixed amount', value: 'amount' },
];

const APPLY_TO_OPTIONS: { label: string; value: ApplyTo }[] = [
  { label: 'Price', value: 'price' },
  { label: 'Compare-at price', value: 'compare_at_price' },
];

const PLATFORM_OPTIONS: { label: string; value: Platform }[] = [
  { label: 'Online store and POS', value: 'BOTH' },
  { label: 'POS only', value: 'POS' },
  { label: 'Online checkout only', value: 'CHECKOUT' },
];

/** Same feature-detection as `BundleEditor` — the resource picker only exists
 * inside the embedded admin, never in local dev outside Shopify. */
function isResourcePickerAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return typeof window.shopify?.resourcePicker === 'function';
  } catch {
    return false;
  }
}

/** `targets` is stored as a JSON string (see `Tier.targets`); this is the
 * display-only parse used to render the picked products as tags. The server's
 * own `parseItems` (src/lib/discountEngines/tier.ts) is what actually matters
 * for the config that gets saved — this just mirrors its "tolerate anything"
 * behaviour so a malformed string renders as no items instead of throwing. */
function parseTargets(targets: string): TierItem[] {
  try {
    const parsed = JSON.parse(targets || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function TierFields({
  value,
  onChange,
}: {
  value: TierFormData;
  onChange: (next: TierFormData) => void;
}) {
  const shopify = useAppBridge();
  const pickerAvailable = isResourcePickerAvailable();

  const updateTier = (id: string, patch: Partial<Tier>) => {
    onChange({
      ...value,
      tiers: value.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  };

  const addTier = () => {
    onChange({ ...value, tiers: [...value.tiers, newTier()] });
  };

  const removeTier = (id: string) => {
    onChange({ ...value, tiers: value.tiers.filter((t) => t.id !== id) });
  };

  /**
   * What this tier targets, in the merchant's words. Drives the button, the
   * empty state and the picker notice together, so a tier set to whole products
   * never invites the merchant to "add variants".
   */
  const nounFor = (tier: Tier) => (
    (tier.selectorType || 'variant_id') === 'product_id'
      ? { one: 'product', many: 'products' }
      : { one: 'variant', many: 'variants' }
  );

  /** The field `buildTierConfig` reads for this tier — the one that must exist. */
  const keyFor = (tier: Tier, item: TierItem) => (
    (tier.selectorType || 'variant_id') === 'product_id' ? item.productId : item.variantId
  );

  const pickProducts = async (tier: Tier) => {
    if (!pickerAvailable) return;
    const selectorType = tier.selectorType || 'variant_id';
    const isProductMode = selectorType === 'product_id';
    try {
      const existing = parseTargets(tier.targets);
      const result = await shopify.resourcePicker({
        type: 'product',
        multiple: true,
        action: 'select',
        // `variants: false` collapses the dialog to whole products, which is
        // what product mode targets. With `true` the merchant checks individual
        // variants under each product.
        filter: { variants: !isProductMode, draft: false, archived: false },
        // Re-open with the current choices already ticked. Ids go back as GIDs
        // — the picker's own currency — while `targets` stores numeric ids.
        selectionIds: existing
          .map((item) => (isProductMode
            ? (item.productId && `gid://shopify/Product/${item.productId}`)
            : (item.variantId && `gid://shopify/ProductVariant/${item.variantId}`)))
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ id })),
      });
      if (!result) return;

      // Ids come back as GIDs and the engine runs `targets` through `Number(...)`,
      // so a GID becomes NaN and the whole tier is dropped. `tierItemsFromPicker`
      // normalises and shapes per mode; the shared engine module is also read by
      // the deployed Rust functions and must not be bent to suit one caller.
      const picked = tierItemsFromPicker(result, selectorType);
      const pickedKeys = new Set(picked.map((p) => (isProductMode ? p.productId : p.variantId)));
      const merged: TierItem[] = [
        ...existing.filter((item) => {
          const key = keyFor(tier, item);
          // An item with no key for this mode is left over from the other mode
          // and would be silently dropped by the engine — drop it here instead.
          return Boolean(key) && !pickedKeys.has(key);
        }),
        ...picked,
      ];
      updateTier(tier.id, { targets: JSON.stringify(merged) });
    } catch {
      // The picker throws when the merchant dismisses it without selecting
      // anything unusual to report — nothing to change here.
    }
  };

  const removeItem = (tier: Tier, key: string) => {
    const remaining = parseTargets(tier.targets).filter((item) => keyFor(tier, item) !== key);
    updateTier(tier.id, { targets: JSON.stringify(remaining) });
  };

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">Discount settings</Text>
          <Select
            label="Discount type"
            options={DISCOUNT_TYPE_OPTIONS}
            value={value.discountType}
            onChange={(discountType) => onChange({ ...value, discountType: discountType as DiscountType })}
          />
          <Select
            label="Apply to"
            options={APPLY_TO_OPTIONS}
            value={value.applyTo}
            onChange={(applyTo) => onChange({ ...value, applyTo: applyTo as ApplyTo })}
          />
          <Select
            label="Available on"
            options={PLATFORM_OPTIONS}
            value={value.platform}
            onChange={(platform) => onChange({ ...value, platform: platform as Platform })}
          />
          <TextField
            label="Message"
            value={value.message}
            onChange={(message) => onChange({ ...value, message })}
            autoComplete="off"
            helpText="Shown to shoppers wherever the discount is applied."
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">Tiers</Text>
          {value.tiers.map((tier, index) => {
            const items = parseTargets(tier.targets);
            return (
              <BlockStack key={tier.id} gap="300">
                {index > 0 && <Divider />}
                <Select
                  label="Match products by"
                  options={[
                    { label: 'Specific variants', value: 'variant_id' },
                    { label: 'Whole products', value: 'product_id' },
                  ]}
                  value={tier.selectorType || 'variant_id'}
                  onChange={(next) => {
                    if (next === (tier.selectorType || 'variant_id')) return;
                    // Clearing is not tidiness: items picked in the other mode
                    // carry the wrong id field for this one, and the engine
                    // would drop them without saying so.
                    updateTier(tier.id, { selectorType: next as Tier['selectorType'], targets: '[]' });
                  }}
                  helpText="Target one size or colour, or the whole product across every variant."
                />

                <InlineStack gap="300" wrap>
                  <TextField
                    label={value.discountType === 'percentage' ? 'Discount percentage' : 'Discount amount'}
                    type="number"
                    value={tier.value}
                    onChange={(v) => updateTier(tier.id, { value: v })}
                    suffix={value.discountType === 'percentage' ? '%' : undefined}
                    autoComplete="off"
                  />
                  <TextField
                    label="Minimum quantity"
                    type="number"
                    value={tier.min_qty}
                    onChange={(nextMinQty) => updateTier(tier.id, { min_qty: nextMinQty })}
                    autoComplete="off"
                    helpText="Leave blank for no minimum."
                  />
                </InlineStack>

                <BlockStack gap="200">
                  {items.length > 0 ? (
                    <InlineStack gap="150">
                      {items.map((item) => (
                        <Tag
                          key={keyFor(tier, item) ?? item.productTitle}
                          onRemove={() => {
                            const key = keyFor(tier, item);
                            return key ? removeItem(tier, key) : undefined;
                          }}
                        >
                          <VariantLabel
                            resolved={undefined}
                            fallback={[item.productTitle, item.variantTitle]
                              .filter(Boolean).join(' — ')
                              || keyFor(tier, item) || 'Unknown product'}
                            layout="inline"
                          />
                        </Tag>
                      ))}
                    </InlineStack>
                  ) : (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`No ${nounFor(tier).many} chosen yet.`}
                    </Text>
                  )}
                  <InlineStack gap="200" blockAlign="center">
                    <Button onClick={() => pickProducts(tier)} disabled={!pickerAvailable}>
                      {`${items.length > 0 ? 'Edit' : 'Add'} ${nounFor(tier).many}`}
                    </Button>
                    {value.tiers.length > 1 && (
                      <Button variant="tertiary" tone="critical" onClick={() => removeTier(tier.id)}>
                        Remove tier
                      </Button>
                    )}
                    {!pickerAvailable && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`The ${nounFor(tier).one} picker is available inside the Shopify admin.`}
                      </Text>
                    )}
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            );
          })}
          <Button onClick={addTier}>Add tier</Button>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
