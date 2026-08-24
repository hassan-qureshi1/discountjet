import { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Divider,
  InlineGrid,
  InlineStack,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  createInitialFormData,
  metafieldSizeBytes,
  METAFIELD_MAX_SIZE_BYTES,
  newBundle,
  newSpecial,
  newTier,
  parseItems,
  STEP_LABELS,
  validate,
  type ApplyTo,
  type BundleDiscount,
  type FormData,
  type Operator,
  type Platform,
  type RuleType,
  type SpecialDiscount,
  type SpecialTarget,
  type Strategy,
  type Tier,
} from './discountForm';
import { Stepper } from '../common/Stepper';
import { TierCard } from './TierCard';
import { BundleDiscountCard } from './BundleDiscountCard';
import { SpecialDiscountCard } from './SpecialDiscountCard';
import { ReviewSummary } from './ReviewSummary';

function PlatformField({ value, onChange }: { value: Platform; onChange: (v: Platform) => void }) {
  return (
    <Select
      label="Where does this apply?"
      options={[
        { label: 'Online store & in person (POS)', value: 'BOTH' },
        { label: 'In person only (POS)', value: 'POS' },
        { label: 'Online store only', value: 'CHECKOUT' },
      ]}
      value={value}
      onChange={(v) => onChange(v as Platform)}
    />
  );
}

export function DiscountFunctionSettings({
  initialRuleType,
  prefill = false,
  onSummaryChange,
}: {
  initialRuleType?: RuleType;
  prefill?: boolean;
  onSummaryChange?: (summary: { products: number }) => void;
}) {
  const [formData, setFormData] = useState<FormData>(() => createInitialFormData(initialRuleType, prefill));
  const [step, setStep] = useState(0);

  const { ruleType, tiers, bundleDiscounts, specialDiscounts } = formData;
  // The offer type is picked in the type-picker modal before this opens, so the
  // wizard skips that step and starts at the first real config step.
  const steps = STEP_LABELS[ruleType].slice(1);
  const lastStep = steps.length - 1;

  // Total chosen products across the current offer type — reported to the host
  // page so it can persist the discount's product count on save.
  const productCount =
    ruleType === 'tier-discount'
      ? tiers.reduce((n, t) => n + parseItems(t.targets).length, 0)
      : ruleType === 'bundle-discount'
        ? bundleDiscounts.reduce(
            (n, b) => n + parseItems(b.source_variants).length + parseItems(b.target_variants).length,
            0,
          )
        : specialDiscounts.reduce(
            (n, s) =>
              n +
              parseItems(s.source_variants).length +
              s.targets.reduce((m, t) => m + parseItems(t.target_variants).length, 0),
            0,
          );
  useEffect(() => {
    onSummaryChange?.({ products: productCount });
  }, [productCount, onSummaryChange]);

  const isTier = ruleType === 'tier-discount';
  const isBundle = ruleType === 'bundle-discount';
  const isSpecial = ruleType === 'special_discount';

  const validationErrors = validate(formData);
  const size = metafieldSizeBytes(formData);

  // ── mutators ──
  const updateField = <K extends keyof FormData>(field: K, value: FormData[K]) =>
    setFormData((prev) => ({ ...prev, [field]: value }));

  const updateTier = (i: number, field: keyof Tier, value: string) =>
    setFormData((prev) => ({ ...prev, tiers: prev.tiers.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)) }));
  const addTier = () => setFormData((prev) => ({ ...prev, tiers: [...prev.tiers, newTier()] }));
  const removeTier = (i: number) => setFormData((prev) => ({ ...prev, tiers: prev.tiers.filter((_, idx) => idx !== i) }));

  const updateBundle = (i: number, field: keyof BundleDiscount, value: string | boolean) =>
    setFormData((prev) => ({
      ...prev,
      bundleDiscounts: prev.bundleDiscounts.map((b, idx) => (idx === i ? { ...b, [field]: value } : b)),
    }));
  const addBundle = () => setFormData((prev) => ({ ...prev, bundleDiscounts: [...prev.bundleDiscounts, newBundle()] }));
  const removeBundle = (i: number) =>
    setFormData((prev) => ({ ...prev, bundleDiscounts: prev.bundleDiscounts.filter((_, idx) => idx !== i) }));

  const updateSpecial = (i: number, field: keyof SpecialDiscount, value: string | boolean | SpecialTarget[]) =>
    setFormData((prev) => ({
      ...prev,
      specialDiscounts: prev.specialDiscounts.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)),
    }));
  const addSpecial = () => setFormData((prev) => ({ ...prev, specialDiscounts: [...prev.specialDiscounts, newSpecial()] }));
  const removeSpecial = (i: number) =>
    setFormData((prev) => ({ ...prev, specialDiscounts: prev.specialDiscounts.filter((_, idx) => idx !== i) }));

  return (
    <BlockStack gap="400">
      <Text as="h3" variant="headingMd">
        Set up your discount
      </Text>

      {validationErrors.length > 0 && (
        <Banner tone="critical" title="Please fix these before saving:">
          <BlockStack gap="100">
            {validationErrors.map((err, i) => (
              <Text key={i} as="span" variant="bodySm">
                {err}
              </Text>
            ))}
          </BlockStack>
        </Banner>
      )}

      {size > METAFIELD_MAX_SIZE_BYTES * 0.8 && (
        <Banner tone={size > METAFIELD_MAX_SIZE_BYTES ? 'critical' : 'warning'}>
          <p>
            {size > METAFIELD_MAX_SIZE_BYTES
              ? 'This offer has too much in it to save. Try splitting it into two separate discounts.'
              : 'This offer is getting large. If it won’t save, try splitting it into two separate discounts.'}
          </p>
        </Banner>
      )}

      <BlockStack gap="150">
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          Step {step + 1} of {steps.length} · {steps[step]}
        </Text>
        <Stepper steps={steps} current={step} onSelect={setStep} />
      </BlockStack>

      <Divider />

      {/* TIER · Discount basics */}
      {isTier && step === 0 && (
        <BlockStack gap="300">
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
            <Select
              label="Discount type"
              options={[
                { label: 'Percentage off', value: 'percentage' },
                { label: 'Fixed amount off', value: 'amount' },
              ]}
              value={formData.discountType}
              onChange={(v) => updateField('discountType', v as Operator)}
            />
            <Select
              label="Discount from"
              options={[
                { label: 'Selling price', value: 'price' },
                { label: 'Original (compare-at) price', value: 'compare_at_price' },
              ]}
              value={formData.applyTo}
              onChange={(v) => updateField('applyTo', v as ApplyTo)}
              helpText="Choose which price the discount is taken off."
            />
            <PlatformField value={formData.platform} onChange={(v) => updateField('platform', v)} />
          </InlineGrid>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
            <div style={{ gridColumn: 'span 2' }}>
              <TextField
                label="Message shown to shoppers at checkout"
                value={formData.message}
                onChange={(v) => updateField('message', v)}
                placeholder="e.g. Buy more, save more"
                autoComplete="off"
              />
            </div>
            <Select
              label="If several products qualify"
              options={[
                { label: 'Discount them all', value: 'ALL' },
                { label: 'Discount the first one', value: 'FIRST' },
                { label: 'Discount the best-value one', value: 'MAXIMUM' },
              ]}
              value={formData.productDiscountSelectionStrategy}
              onChange={(v) => updateField('productDiscountSelectionStrategy', v as Strategy)}
            />
          </InlineGrid>
        </BlockStack>
      )}

      {/* TIER · Step 2 Savings levels */}
      {isTier && step === 1 && (
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Savings levels
          </Text>
          <Text as="p" variant="bodyMd">
            Each level sets a discount and the products it applies to.
          </Text>
          {tiers.map((tier, i) => (
            <TierCard
              key={tier.id}
              tier={tier}
              tierIndex={i}
              discountType={formData.discountType}
              canRemove={tiers.length > 1}
              onUpdate={(field, value) => updateTier(i, field, value)}
              onRemove={() => removeTier(i)}
            />
          ))}
          <InlineStack>
            <Button onClick={addTier}>Add another level</Button>
          </InlineStack>
        </BlockStack>
      )}

      {/* BUNDLE · Step 1 Products */}
      {isBundle && step === 0 && (
        <BlockStack gap="300">
          <Banner tone="warning">
            <p>
              You can’t add the same discounted product to more than one offer here. To do that, create a separate
              discount — Shopify always applies the best one for the shopper.
            </p>
          </Banner>
          <Text as="h3" variant="headingSm">
            Your offers
          </Text>
          {bundleDiscounts.map((bundle, i) => (
            <BundleDiscountCard
              key={bundle.id}
              bundle={bundle}
              bundleIndex={i}
              section="products"
              canRemove={bundleDiscounts.length > 1}
              onUpdate={(field, value) => updateBundle(i, field, value)}
              onRemove={() => removeBundle(i)}
            />
          ))}
          <InlineStack>
            <Button onClick={addBundle}>Add another offer</Button>
          </InlineStack>
        </BlockStack>
      )}

      {/* BUNDLE · Step 2 Discount & rules */}
      {isBundle && step === 1 && (
        <BlockStack gap="300">
          <PlatformField value={formData.platform} onChange={(v) => updateField('platform', v)} />
          <Divider />
          {bundleDiscounts.map((bundle, i) => (
            <BundleDiscountCard
              key={bundle.id}
              bundle={bundle}
              bundleIndex={i}
              section="rules"
              canRemove={bundleDiscounts.length > 1}
              onUpdate={(field, value) => updateBundle(i, field, value)}
              onRemove={() => removeBundle(i)}
            />
          ))}
        </BlockStack>
      )}

      {/* SPECIAL · Step 1 Products */}
      {isSpecial && step === 0 && (
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Your offers
          </Text>
          {specialDiscounts.map((special, i) => (
            <SpecialDiscountCard
              key={special.id}
              special={special}
              discountIndex={i}
              section="products"
              canRemove={specialDiscounts.length > 1}
              onUpdate={(field, value) => updateSpecial(i, field, value)}
              onRemove={() => removeSpecial(i)}
            />
          ))}
          <InlineStack>
            <Button onClick={addSpecial}>Add another offer</Button>
          </InlineStack>
        </BlockStack>
      )}

      {/* SPECIAL · Step 2 Discount & rules */}
      {isSpecial && step === 1 && (
        <BlockStack gap="300">
          <PlatformField value={formData.platform} onChange={(v) => updateField('platform', v)} />
          <Divider />
          {specialDiscounts.map((special, i) => (
            <SpecialDiscountCard
              key={special.id}
              special={special}
              discountIndex={i}
              section="rules"
              canRemove={specialDiscounts.length > 1}
              onUpdate={(field, value) => updateSpecial(i, field, value)}
              onRemove={() => removeSpecial(i)}
            />
          ))}
        </BlockStack>
      )}

      {/* Review */}
      {step === lastStep && (
        <BlockStack gap="300">
          <ReviewSummary formData={formData} />
          <Banner tone="success">
            <p>All set. Press Save at the top of the page to publish this discount. Use Back to edit any step.</p>
          </Banner>
        </BlockStack>
      )}

      <Divider />
      <InlineStack gap="300" align="space-between">
        <Badge tone="magic">discount-ui</Badge>
        <InlineStack gap="200">
          {step > 0 && <Button onClick={() => setStep((s) => Math.max(0, s - 1))}>← Back</Button>}
          {step < lastStep && (
            <Button variant="primary" onClick={() => setStep((s) => Math.min(lastStep, s + 1))}>
              Next →
            </Button>
          )}
        </InlineStack>
      </InlineStack>
    </BlockStack>
  );
}
