// Read-only summary shown on the wizard's Review step.
// One layered card per savings level: header + plain-English headline +
// products column + detail rows. Renders from formData only — no metafield writes.
import type {
  ApplyTo,
  DiscountType,
  Platform,
  SelectionStrategy,
  SelectorType,
  TierFormData,
  TierItem,
} from "./config";

interface GroupedItems {
  lines: string[];
  count: number;
}

function parseItems(json: string): TierItem[] {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Group selected items by product so the product name shows once, with its
// variant SKUs listed in brackets: "Delve Bed Frame (DBF-K-MC, DBF-K-BC)".
function groupItems(json: string, selectorType: SelectorType): GroupedItems {
  const isProduct = (selectorType || "variant_id") === "product_id";
  const items = parseItems(json);
  if (isProduct) {
    return {
      lines: items.map((it) => it.productTitle || `Product ${it.productId ?? ""}`.trim()),
      count: items.length,
    };
  }
  const groups = new Map<string, { title: string; skus: string[] }>();
  for (const it of items) {
    const key = it.productId || it.productTitle || "?";
    const title = it.productTitle || `Product ${it.productId ?? ""}`.trim();
    const sku = it.sku || it.variantTitle || it.variantId || "";
    if (!groups.has(key)) groups.set(key, { title, skus: [] });
    if (sku) groups.get(key)!.skus.push(sku);
  }
  const lines = [...groups.values()].map((g) =>
    g.skus.length ? `${g.title} (${g.skus.join(", ")})` : g.title,
  );
  return { lines, count: items.length };
}

function discountPhrase(discountType: DiscountType, value: string): string {
  const v = value || "0";
  return discountType === "percentage" ? `${v}% off` : `$${v} off`;
}

function applyFromLabel(applyTo: ApplyTo): string {
  return applyTo === "compare_at_price" ? "original (compare-at) price" : "selling price";
}

function platformLabel(platform: Platform): string {
  if (platform === "POS") return "In person only (POS)";
  if (platform === "CHECKOUT") return "Online store only";
  return "Online store & in person (POS)";
}

function strategyLabel(strategy: SelectionStrategy): string {
  if (strategy === "FIRST") return "the first qualifying product";
  if (strategy === "MAXIMUM") return "the best-value product";
  return "every qualifying product";
}

interface Column {
  label: string;
  lines: string[];
  count: number;
}

function ProductColumn({ label, lines, count }: Column) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text type="strong">
          {label} ({count})
        </s-text>
        {lines.length > 0 ? (
          lines.map((n, i) => <s-text key={i}>• {n}</s-text>)
        ) : (
          <s-text color="subdued">No products chosen yet</s-text>
        )}
      </s-stack>
    </s-box>
  );
}

function DetailRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <s-stack gap="small-200">
      {rows.map(([k, v], i) => (
        <s-grid key={i} gridTemplateColumns="1fr 1fr" gap="base">
          <s-text color="subdued">{k}</s-text>
          <s-text type="strong">{v}</s-text>
        </s-grid>
      ))}
    </s-stack>
  );
}

interface Offer {
  title: string;
  badge: string;
  headline: string;
  column: Column;
  rows: Array<[string, string]>;
}

function buildTierOffers(formData: TierFormData): Offer[] {
  const { discountType, applyTo, productDiscountSelectionStrategy, tiers } = formData;
  const tiersArr = Array.isArray(tiers) ? tiers : [];
  return tiersArr.map((tier, i) => {
    const products = groupItems(tier.targets, tier.selectorType);
    const phrase = discountPhrase(discountType, tier.value);
    const min = tier.min_qty ? parseInt(tier.min_qty, 10) : 0;
    const headline =
      min > 0
        ? `Buy ${min}+ of these products to get ${phrase}.`
        : `Get ${phrase} on these products.`;
    return {
      title: `Savings level ${i + 1}`,
      badge: phrase,
      headline,
      column: { label: "These products", lines: products.lines, count: products.count },
      rows: [
        ["Discount", `${phrase} · from the ${applyFromLabel(applyTo)}`],
        ["Minimum quantity", min > 0 ? String(min) : "No minimum"],
        ["If several qualify", `Discount ${strategyLabel(productDiscountSelectionStrategy)}`],
      ],
    };
  });
}

export function ReviewSummary({ formData }: { formData: TierFormData }) {
  const offers = buildTierOffers(formData);
  const sharedLine = `All levels: discount from the ${applyFromLabel(formData.applyTo)} · applies to ${strategyLabel(
    formData.productDiscountSelectionStrategy,
  )} · works ${platformLabel(formData.platform).toLowerCase()}${
    formData.message ? ` · shown as “${formData.message}”` : ""
  }.`;

  return (
    <s-stack gap="base">
      <s-heading>Here’s what shoppers will get</s-heading>
      <s-text color="subdued">{sharedLine}</s-text>
      {offers.length > 0 ? (
        offers.map((offer, i) => (
          <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading>{offer.title}</s-heading>
                <s-badge tone="info">{offer.badge}</s-badge>
              </s-stack>
              <s-text>{offer.headline}</s-text>
              <s-divider />
              <ProductColumn {...offer.column} />
              <s-divider />
              <DetailRows rows={offer.rows} />
            </s-stack>
          </s-box>
        ))
      ) : (
        <s-text color="subdued">Nothing configured yet.</s-text>
      )}
    </s-stack>
  );
}
