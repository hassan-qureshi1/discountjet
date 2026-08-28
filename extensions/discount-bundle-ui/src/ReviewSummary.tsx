// Read-only summary shown on the wizard's Review step.
// One layered card per offer: header + plain-English headline + Buy→Get
// columns + detail rows. Renders from formData only — no metafield writes.
import type { ApplyTo, BundleFormData, Operator, Platform, SelectionStrategy, SelectorType } from "./config";
import { parseItems } from "./config";

interface GroupedItems {
  lines: string[];
  count: number;
}

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
  const lines = [...groups.values()].map((g) => (g.skus.length ? `${g.title} (${g.skus.join(", ")})` : g.title));
  return { lines, count: items.length };
}

function discountPhrase(operator: Operator, value: string): string {
  const v = value || "0";
  return operator === "percentage" ? `${v}% off` : `$${v} off`;
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
  badges: string[];
  headline: string;
  columns: Column[];
  rows: Array<[string, string]>;
}

function buildBundleOffers(formData: BundleFormData): Offer[] {
  const bundles = Array.isArray(formData.bundles) ? formData.bundles : [];
  return bundles.map((b, i) => {
    const buys = groupItems(b.source_variants, b.sourceSelectorType);
    const gets = groupItems(b.target_variants, b.targetSelectorType);
    const phrase = discountPhrase(b.operator, b.value);
    const min = b.min_qty ? parseInt(b.min_qty, 10) : 0;
    const headline = `When a shopper buys ${
      min > 0 ? `${min}+ ` : ""
    }of the qualifying products, the chosen products get ${phrase}.`;
    const rows: Array<[string, string]> = [
      ["Discount", `${phrase} · from the ${applyFromLabel(b.apply_to)}`],
      ["Minimum to buy", min > 0 ? String(min) : "No minimum"],
    ];
    if (b.quantity_dependent) {
      rows.push(["Discounted per qualifying item", String(b.target_per_source || 1)]);
      rows.push(["Require exact sets", b.fixed_ratios ? "Yes" : "No"]);
      if (b.fixed_ratios && b.max_target_qty) {
        rows.push(["Maximum discounted items", String(b.max_target_qty)]);
      }
    }
    rows.push(["If several qualify", `Discount ${strategyLabel(b.selectionStrategy)}`]);
    rows.push(["Checkout message", b.message ? `“${b.message}”` : "—"]);
    return {
      title: `Offer ${i + 1}`,
      badges: [phrase, platformLabel(formData.platform)],
      headline,
      columns: [
        { label: "Shopper buys", lines: buys.lines, count: buys.count },
        { label: `Gets ${phrase}`, lines: gets.lines, count: gets.count },
      ],
      rows,
    };
  });
}

export function ReviewSummary({ formData }: { formData: BundleFormData }) {
  const offers = buildBundleOffers(formData);
  return (
    <s-stack gap="base">
      <s-heading>Here’s what shoppers will get</s-heading>
      {offers.length > 0 ? (
        offers.map((offer, i) => (
          <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading>{offer.title}</s-heading>
                {offer.badges.map((b, j) => (
                  <s-badge key={b} tone={j === 0 ? "info" : undefined}>
                    {b}
                  </s-badge>
                ))}
              </s-stack>
              <s-text>{offer.headline}</s-text>
              <s-divider />
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                {offer.columns.map((c) => (
                  <ProductColumn key={c.label} {...c} />
                ))}
              </s-grid>
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
