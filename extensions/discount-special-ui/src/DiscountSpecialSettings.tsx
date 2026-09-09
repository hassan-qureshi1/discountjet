import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  buildSpecialConfig,
  getMetafieldSizeBytes,
  METAFIELD_KEY,
  METAFIELD_MAX_SIZE_BYTES,
  METAFIELD_NAMESPACE,
  newSpecial,
  parseMetafield,
  validateMetafieldSize,
  validateSpecialConfig,
  type Platform,
  type Special,
  type SpecialFormData,
  type TargetGroup,
} from "./config";
import { SpecialCard } from "./SpecialCard";
import { ReviewSummary } from "./ReviewSummary";

const METAFIELD_DEFINITION_NAME = "Buy X, discount both configuration";

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

// Wizard steps. The offer type is fixed (this is the Buy X, discount both function).
const STEP_LABELS = ["Products", "Discount & rules", "Review"] as const;

/** True once at least one offer has a qualifying product and a discounted set. */
function hasSpecialData(specials: Special[]): boolean {
  return specials.some((s) => {
    try {
      const src = JSON.parse(s?.source_variants || "[]");
      if (!Array.isArray(src) || src.length === 0) return false;
      const targets = Array.isArray(s?.targets) ? s.targets : [];
      return targets.some((t) => {
        const arr = JSON.parse(t?.target_variants || "[]");
        return Array.isArray(arr) && arr.length > 0;
      });
    } catch {
      return false;
    }
  });
}

function App() {
  const initial = useMemo<SpecialFormData>(() => {
    const raw = shopify.data?.metafields?.find((m) => m.key === METAFIELD_KEY)?.value;
    return parseMetafield(raw);
  }, []);
  const [formData, setFormData] = useState<SpecialFormData>(initial);

  useEffect(() => {
    const classes = shopify.discounts?.discountClasses?.value ?? [];
    if (!classes.includes("product")) {
      void shopify.discounts?.updateDiscountClasses?.([...classes, "product"]);
    }
  }, []);

  const lastStep = STEP_LABELS.length - 1;
  const [step, setStep] = useState(() => (hasSpecialData(initial.specials) ? lastStep : 0));
  const goNext = () => setStep((s) => Math.min(s + 1, lastStep));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const sizeBytes = useMemo(() => getMetafieldSizeBytes(formData), [formData]);
  const validationErrors = useMemo(() => validateSpecialConfig(formData), [formData]);

  // Use the functional setState form so two updates fired from one event handler
  // (e.g. changing "Match products by" clears the picked items) compose instead
  // of the second overwriting the first from a stale snapshot.
  const patch = (p: Partial<SpecialFormData>) => setFormData((prev) => ({ ...prev, ...p }));
  const updateSpecial = (index: number, field: keyof Special, value: string | boolean | TargetGroup[]) =>
    setFormData((prev) => ({
      ...prev,
      specials: prev.specials.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    }));
  const addSpecial = () => setFormData((prev) => ({ ...prev, specials: [...prev.specials, newSpecial()] }));
  const removeSpecial = (index: number) =>
    setFormData((prev) => ({ ...prev, specials: prev.specials.filter((_, i) => i !== index) }));

  // Picker-driven updates don't fire native input events; nudge the host so the
  // native Save button appears once offers exist.
  useEffect(() => {
    const el = document.querySelector("s-function-settings");
    if (el && formData.specials.length) {
      el.dispatchEvent?.(new Event("input", { bubbles: true }));
    }
  }, [formData]);

  const apply = async () => {
    const errors = validateSpecialConfig(formData);
    if (errors.length > 0) throw new Error(errors.join(" "));
    const value = JSON.stringify(buildSpecialConfig(formData));
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

  const platformField = (
    <s-select
      required
      label="Where does this apply?"
      value={formData.platform}
      onChange={(e: Event) => patch({ platform: (e.currentTarget as HTMLSelectElement).value as Platform })}
    >
      <s-option value="BOTH">Online store &amp; in person (POS)</s-option>
      <s-option value="POS">In person only (POS)</s-option>
      <s-option value="CHECKOUT">Online store only</s-option>
    </s-select>
  );

  return (
    <s-function-settings onSubmit={(event) => event.waitUntil?.(apply())}>
      <s-heading>Set up your Buy X, discount both offer</s-heading>

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

          {/* ---------- STEP 0 · Products ---------- */}
          {step === 0 ? (
            <s-stack gap="base">
              <s-heading>Your offers</s-heading>
              {formData.specials.length > 0 ? (
                formData.specials.map((special, index) => (
                  <SpecialCard
                    key={special.id}
                    special={special}
                    specialIndex={index}
                    allSpecials={formData.specials}
                    onUpdate={(field, value) => updateSpecial(index, field, value)}
                    onRemove={() => removeSpecial(index)}
                    section="products"
                  />
                ))
              ) : (
                <s-text>No offers yet — add one to get started.</s-text>
              )}
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button onClick={addSpecial} variant="secondary">
                  Add another offer
                </s-button>
              </s-stack>
            </s-stack>
          ) : null}

          {/* ---------- STEP 1 · Discount & rules ---------- */}
          {step === 1 ? (
            <s-stack gap="base">
              {platformField}
              <s-divider />
              {formData.specials.map((special, index) => (
                <SpecialCard
                  key={special.id}
                  special={special}
                  specialIndex={index}
                  allSpecials={formData.specials}
                  onUpdate={(field, value) => updateSpecial(index, field, value)}
                  onRemove={() => removeSpecial(index)}
                  section="rules"
                />
              ))}
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
