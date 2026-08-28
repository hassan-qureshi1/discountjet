import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useMemo, useState, useEffect } from "preact/hooks";
import {
  buildTierConfig,
  getMetafieldSizeBytes,
  METAFIELD_KEY,
  METAFIELD_MAX_SIZE_BYTES,
  METAFIELD_NAMESPACE,
  newTier,
  parseMetafield,
  validateMetafieldSize,
  validateTierConfig,
  type ApplyTo,
  type DiscountType,
  type Platform,
  type SelectionStrategy,
  type Tier,
  type TierFormData,
} from "./config";
import { TierCard } from "./TierCard";
import { ReviewSummary } from "./ReviewSummary";

const METAFIELD_DEFINITION_NAME = "Volume discount configuration";

// A DISCOUNT-owner metafield definition granting the merchant read/write access
// must exist before the settings UI can save the config metafield, otherwise the
// write is rejected with "Access to this namespace and key ... is not allowed".
// Ensure it once on load (create if missing).
async function ensureMetafieldDefinition(): Promise<void> {
  const existing = await shopify.query<{ metafieldDefinitions: { nodes: Array<{ id: string }> } }>(
    `#graphql
      query DiscountConfigDefinition {
        metafieldDefinitions(first: 1, ownerType: DISCOUNT, namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
          nodes { id }
        }
      }`,
  );
  if (existing?.data?.metafieldDefinitions?.nodes?.length) return;

  const created = await shopify.query<{
    metafieldDefinitionCreate: { createdDefinition: { id: string } | null; userErrors: Array<{ message: string }> };
  }>(
    `#graphql
      mutation CreateDiscountConfigDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { message }
        }
      }`,
    {
      variables: {
        definition: {
          access: { admin: "MERCHANT_READ_WRITE" },
          key: METAFIELD_KEY,
          name: METAFIELD_DEFINITION_NAME,
          namespace: METAFIELD_NAMESPACE,
          ownerType: "DISCOUNT",
          type: "json",
        },
      },
    },
  );

  const result = created?.data?.metafieldDefinitionCreate;
  if (!result?.createdDefinition) {
    const errors = result?.userErrors ?? [];
    // A concurrent load may have created it first — ignore "already taken".
    if (errors.length && !errors.some((e) => /taken|already/i.test(e.message))) {
      throw new Error(`Could not set up discount configuration: ${errors.map((e) => e.message).join(" ")}`);
    }
  }
}

export default async () => {
  await ensureMetafieldDefinition();
  render(<App />, document.body);
};

// Wizard steps. The offer type is fixed (this is the Volume discount function),
// so there is no "offer type" step — go straight to Discount → Savings → Review.
const STEP_LABELS = ["Discount", "Savings levels", "Review"] as const;

/** True once at least one savings level has products chosen. */
function hasTierData(tiers: Tier[]): boolean {
  return tiers.some((tier) => {
    try {
      const parsed = JSON.parse(tier?.targets || "[]");
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  });
}

function App() {
  const initial = useMemo<TierFormData>(() => {
    const raw = shopify.data?.metafields?.find((m) => m.key === METAFIELD_KEY)?.value;
    return parseMetafield(raw);
  }, []);

  const [formData, setFormData] = useState<TierFormData>(initial);

  // The tier function is PRODUCT-class; ensure the discount grants it.
  useEffect(() => {
    const classes = shopify.discounts?.discountClasses?.value ?? [];
    if (!classes.includes("product")) {
      void shopify.discounts?.updateDiscountClasses?.([...classes, "product"]);
    }
  }, []);

  const lastStep = STEP_LABELS.length - 1;
  // An already-created discount opens on Review (read-first, editable via Back);
  // a new/empty one starts at the beginning. Computed once from pre-filled data.
  const [step, setStep] = useState(() => (hasTierData(initial.tiers) ? lastStep : 0));
  const goNext = () => setStep((s) => Math.min(s + 1, lastStep));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const sizeBytes = useMemo(() => getMetafieldSizeBytes(formData), [formData]);
  const validationErrors = useMemo(() => validateTierConfig(formData), [formData]);

  // Use the functional setState form so two updates fired from one event handler
  // (e.g. changing "Match products by" clears the picked items) compose instead
  // of the second overwriting the first from a stale snapshot.
  const patch = (p: Partial<TierFormData>) => setFormData((prev) => ({ ...prev, ...p }));

  const updateTier = (index: number, field: keyof Tier, value: string) =>
    setFormData((prev) => ({
      ...prev,
      tiers: prev.tiers.map((t, i) => (i === index ? { ...t, [field]: value } : t)),
    }));
  const addTier = () => setFormData((prev) => ({ ...prev, tiers: [...prev.tiers, newTier()] }));
  const removeTier = (index: number) =>
    setFormData((prev) => ({ ...prev, tiers: prev.tiers.filter((_, i) => i !== index) }));

  // Notify the host that the form changed after picker-driven updates (which
  // don't fire native input events) so the native Save button appears.
  useEffect(() => {
    const el = document.querySelector("s-function-settings");
    if (el && formData.tiers.length) {
      el.dispatchEvent?.(new Event("input", { bubbles: true }));
    }
  }, [formData]);

  const applyExtensionMetafieldChange = async () => {
    const errors = validateTierConfig(formData);
    if (errors.length > 0) throw new Error(errors.join(" "));
    const value = JSON.stringify(buildTierConfig(formData));
    validateMetafieldSize(value);
    await shopify.applyMetafieldChange({
      type: "updateMetafield",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      value,
      valueType: "json",
    });
  };

  const kb = (sizeBytes / 1024).toFixed(2);
  const overWarn = sizeBytes > METAFIELD_MAX_SIZE_BYTES * 0.8;
  const overLimit = sizeBytes > METAFIELD_MAX_SIZE_BYTES;

  return (
    <s-function-settings
      onSubmit={(event) => {
        event.waitUntil?.(applyExtensionMetafieldChange());
      }}
    >
      <s-heading>Set up your volume discount</s-heading>

      <s-section>
        <s-stack gap="base">
          {validationErrors.length > 0 ? (
            <s-banner tone="critical" heading="Please fix these before saving:">
              <s-stack gap="small-200">
                {validationErrors.map((e) => (
                  <s-text key={e}>{e}</s-text>
                ))}
              </s-stack>
            </s-banner>
          ) : null}

          {overWarn ? (
            <s-banner tone={overLimit ? "critical" : "warning"}>
              {overLimit
                ? "This offer has too much in it to save. Try splitting it into two separate discounts."
                : `This offer is getting large (${kb} KB / 10 KB). If it won’t save, try splitting it into two separate discounts.`}
            </s-banner>
          ) : null}

          {/* Progress indicator */}
          <s-stack gap="small-200">
            <s-text type="strong">
              Step {step + 1} of {STEP_LABELS.length} · {STEP_LABELS[step]}
            </s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {STEP_LABELS.map((label, i) => (
                <s-clickable-chip
                  key={label}
                  color={i === step ? "strong" : i < step ? "base" : "subdued"}
                  accessibilityLabel={`Go to step ${i + 1}: ${label}`}
                  onClick={() => setStep(i)}
                >
                  {i < step ? `✓ ${label}` : `${i + 1}. ${label}`}
                </s-clickable-chip>
              ))}
            </s-stack>
          </s-stack>

          <s-divider />

          {/* ---------- STEP 0 · Discount ---------- */}
          {step === 0 ? (
            <s-stack gap="base">
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-select
                  label="Discount type"
                  value={formData.discountType}
                  onChange={(e: Event) =>
                    patch({ discountType: (e.currentTarget as HTMLSelectElement).value as DiscountType })
                  }
                >
                  <s-option value="percentage">Percentage off</s-option>
                  <s-option value="amount">Fixed amount off</s-option>
                </s-select>
                <s-select
                  label="Discount from"
                  details="Choose which price the discount is taken off."
                  value={formData.applyTo}
                  onChange={(e: Event) =>
                    patch({ applyTo: (e.currentTarget as HTMLSelectElement).value as ApplyTo })
                  }
                >
                  <s-option value="price">Selling price</s-option>
                  <s-option value="compare_at_price">Original (compare-at) price</s-option>
                </s-select>
                <s-select
                  label="Where does this apply?"
                  value={formData.platform}
                  onChange={(e: Event) =>
                    patch({ platform: (e.currentTarget as HTMLSelectElement).value as Platform })
                  }
                >
                  <s-option value="BOTH">Online store &amp; in person (POS)</s-option>
                  <s-option value="POS">In person only (POS)</s-option>
                  <s-option value="CHECKOUT">Online store only</s-option>
                </s-select>
                <s-select
                  label="If several products qualify"
                  value={formData.productDiscountSelectionStrategy}
                  onChange={(e: Event) =>
                    patch({
                      productDiscountSelectionStrategy: (e.currentTarget as HTMLSelectElement)
                        .value as SelectionStrategy,
                    })
                  }
                >
                  <s-option value="ALL">Discount them all</s-option>
                  <s-option value="FIRST">Discount the first one</s-option>
                  <s-option value="MAXIMUM">Discount the best-value one</s-option>
                </s-select>
              </s-grid>
              <s-text-field
                label="Message shown to shoppers at checkout"
                placeholder="e.g. Buy more, save more"
                value={formData.message}
                onChange={(e: Event) => patch({ message: (e.currentTarget as HTMLInputElement).value })}
              />
            </s-stack>
          ) : null}

          {/* ---------- STEP 1 · Savings levels ---------- */}
          {step === 1 ? (
            <s-stack gap="base">
              <s-heading>Savings levels</s-heading>
              <s-text>Each level sets a discount and the products it applies to.</s-text>
              {formData.tiers.map((tier, index) => (
                <TierCard
                  key={tier.id}
                  tier={tier}
                  tierIndex={index}
                  discountType={formData.discountType}
                  allTiers={formData.tiers}
                  onUpdate={(field, value) => updateTier(index, field, value)}
                  onRemove={() => removeTier(index)}
                />
              ))}
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button onClick={addTier} variant="secondary">
                  Add another level
                </s-button>
              </s-stack>
            </s-stack>
          ) : null}

          {/* ---------- STEP 2 · Review ---------- */}
          {step === lastStep ? (
            <s-stack gap="base">
              <ReviewSummary formData={formData} />
              <s-banner tone="success">
                All set. Press Save at the top of the page to publish this discount. Use Back to edit any
                step.
              </s-banner>
            </s-stack>
          ) : null}

          {/* ---------- Wizard navigation ---------- */}
          <s-divider />
          <s-stack direction="inline" gap="base" alignItems="center">
            {step > 0 ? (
              <s-button onClick={goBack} variant="secondary">
                ← Back
              </s-button>
            ) : null}
            {step < lastStep ? (
              <s-button onClick={goNext} variant="primary">
                Next →
              </s-button>
            ) : null}
          </s-stack>
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
