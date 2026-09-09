// Read-only summary shown on the wizard's Review step.
// One layered card per offer: header + plain-English headline + Buy→Get
// columns + detail rows. Renders from formData only — no metafield writes.
import type { ApplyTo, Operator, Platform, SelectionStrategy, SelectorType, SpecialFormData } from "./config";
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
  sublabel?: string;
  lines: string[];
  count: number;
}

function ProductColumn({ label, sublabel, lines, count }: Column) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text type="strong">
          {label} ({count})
        </s-text>
        {sublabel ? <s-text color="subdued">{sublabel}</s-text> : null}
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

function buildSpecialOffers(formData: SpecialFormData): Offer[] {
  const specials = Array.isArray(formData.specials) ? formData.specials : [];
  return specials.map((s, i) => {
    const buys = groupItems(s.source_variants, s.sourceSelectorType);
    const sourcePhrase = discountPhrase(s.source_operator, s.source_value);
    const targets = Array.isArray(s.targets) ? s.targets : [];
    // Flatten target sets into one "gets" column, appending each set's discount.
    const getsLines: string[] = [];
    let getsCount = 0;
    for (const t of targets) {
      const g = groupItems(t.target_variants, t.targetSelectorType);
      const tp = discountPhrase(t.target_operator, t.target_value);
      getsLines.push(...g.lines.map((n) => `${n} — ${tp}`));
      getsCount += g.count;
    }
    const min = s.min_qty ? parseInt(s.min_qty, 10) : 0;
    const headline = `Buy ${
      min > 0 ? `${min}+ ` : ""
    }of the qualifying products (${sourcePhrase}) and unlock discounts on the paired products too.`;
    const rows: Array<[string, string]> = [
      ["Qualifying products get", sourcePhrase],
      ["Discount from", `the ${applyFromLabel(s.apply_to)}`],
      ["Minimum to buy", min > 0 ? String(min) : "No minimum"],
    ];
    if (s.quantity_dependent) {
      rows.push(["Discounted per qualifying item", String(s.target_per_source || 1)]);
    }
    rows.push(["If several qualify", `Discount ${strategyLabel(s.selectionStrategy)}`]);
    rows.push(["Checkout message", s.message ? `“${s.message}”` : "—"]);
    return {
      title: `Offer ${i + 1}`,
      badges: [sourcePhrase, platformLabel(formData.platform)],
      headline,
      columns: [
        { label: "Shopper buys", sublabel: sourcePhrase, lines: buys.lines, count: buys.count },
        { label: "Also discounted", lines: getsLines, count: getsCount },
      ],
      rows,
    };
  });
}

export function ReviewSummary({ formData }: { formData: SpecialFormData }) {
  const offers = buildSpecialOffers(formData);
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
