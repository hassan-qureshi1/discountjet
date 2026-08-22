import { Badge, BlockStack, Box, Divider, InlineGrid, InlineStack, Text } from '@shopify/polaris';
import {
  applyFromLabel,
  discountPhrase,
  parseItems,
  platformLabel,
  strategyLabel,
  type FormData,
  type ProductItem,
  type SelectorType,
  type VariantItem,
} from './discountForm';

interface GroupResult {
  lines: string[];
  count: number;
}

// Group selected items by product so the product name shows once, with its
// variant SKUs listed in brackets: "Oak Bed Frame (OBF-Q)".
function groupItems(json: string, selectorType: SelectorType): GroupResult {
  if (selectorType === 'product_id') {
    const items = parseItems<ProductItem>(json);
    return { lines: items.map((it) => it.productTitle || `Product ${it.productId}`), count: items.length };
  }
  const items = parseItems<VariantItem>(json);
  const groups = new Map<string, { title: string; skus: string[] }>();
  for (const it of items) {
    const key = it.productId || it.productTitle || '?';
    const title = it.productTitle || `Product ${it.productId}`;
    const sku = it.sku || it.variantTitle || it.variantId || '';
    if (!groups.has(key)) groups.set(key, { title, skus: [] });
    if (sku) groups.get(key)!.skus.push(sku);
  }
  const lines = Array.from(groups.values()).map((g) => (g.skus.length ? `${g.title} (${g.skus.join(', ')})` : g.title));
  return { lines, count: items.length };
}

interface Column {
  label: string;
  sublabel?: string;
  lines: string[];
  count: number;
}
interface Offer {
  title: string;
  badges: string[];
  headline: string;
  columns: Column[];
  rows: [string, string][];
}

function ProductColumn({ label, sublabel, lines, count }: Column) {
  return (
    <Box padding="300" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="150">
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {label} ({count})
        </Text>
        {sublabel && (
          <Text as="span" variant="bodySm" tone="subdued">
            {sublabel}
          </Text>
        )}
        {lines.length > 0 ? (
          lines.map((n, i) => (
            <Text key={i} as="span" variant="bodySm">
              • {n}
            </Text>
          ))
        ) : (
          <Text as="span" variant="bodySm" tone="subdued">
            No products chosen yet
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

function OfferCard({ title, badges, headline, columns, rows }: Offer) {
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h4" variant="headingSm">
            {title}
          </Text>
          {badges.map((b, i) => (
            <Badge key={i} tone={i === 0 ? 'info' : undefined}>
              {b}
            </Badge>
          ))}
        </InlineStack>
        <Text as="p" variant="bodyMd">
          {headline}
        </Text>
        <Divider />
        <InlineGrid columns={columns.length > 1 ? { xs: 1, sm: 2 } : 1} gap="300">
          {columns.map((c, i) => (
            <ProductColumn key={i} {...c} />
          ))}
        </InlineGrid>
        <Divider />
        <BlockStack gap="150">
          {rows.map(([k, v], i) => (
            <InlineGrid key={i} columns={2} gap="300">
              <Text as="span" variant="bodySm" tone="subdued">
                {k}
              </Text>
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {v}
              </Text>
            </InlineGrid>
          ))}
        </BlockStack>
      </BlockStack>
    </Box>
  );
}

function buildTierOffers(formData: FormData): Offer[] {
  const { discountType, applyTo, productDiscountSelectionStrategy, tiers } = formData;
  return tiers.map((tier, i) => {
    const products = groupItems(tier.targets, tier.selectorType);
    const phrase = discountPhrase(discountType, tier.value);
    const min = tier.min_qty ? parseInt(tier.min_qty, 10) : 0;
    return {
      title: `Savings level ${i + 1}`,
      badges: [phrase],
      headline: min > 0 ? `Buy ${min}+ of these products to get ${phrase}.` : `Get ${phrase} on these products.`,
      columns: [{ label: 'These products', lines: products.lines, count: products.count }],
      rows: [
        ['Discount', `${phrase} · from the ${applyFromLabel(applyTo)}`],
        ['Minimum quantity', min > 0 ? String(min) : 'No minimum'],
        ['If several qualify', `Discount ${strategyLabel(productDiscountSelectionStrategy)}`],
      ],
    };
  });
}

function buildBundleOffers(formData: FormData): Offer[] {
  return formData.bundleDiscounts.map((b, i) => {
    const buys = groupItems(b.source_variants, b.sourceSelectorType);
    const gets = groupItems(b.target_variants, b.targetSelectorType);
    const phrase = discountPhrase(b.operator, b.value);
    const min = b.min_qty ? parseInt(b.min_qty, 10) : 0;
    const rows: [string, string][] = [
      ['Discount', `${phrase} · from the ${applyFromLabel(b.apply_to)}`],
      ['Minimum to buy', min > 0 ? String(min) : 'No minimum'],
    ];
    if (b.quantity_dependent) {
      rows.push(['Discounted per qualifying item', String(b.target_per_source || 1)]);
      rows.push(['Require exact sets', b.fixed_ratios ? 'Yes' : 'No']);
    }
    rows.push(['If several qualify', `Discount ${strategyLabel(b.selectionStrategy)}`]);
    rows.push(['Checkout message', b.message ? `“${b.message}”` : '—']);
    return {
      title: `Offer ${i + 1}`,
      badges: [phrase, platformLabel(formData.platform)],
      headline: `When a shopper buys ${min > 0 ? `${min}+ ` : ''}of the qualifying products, the chosen products get ${phrase}.`,
      columns: [
        { label: 'Shopper buys', lines: buys.lines, count: buys.count },
        { label: `Gets ${phrase}`, lines: gets.lines, count: gets.count },
      ],
      rows,
    };
  });
}

function buildSpecialOffers(formData: FormData): Offer[] {
  return formData.specialDiscounts.map((s, i) => {
    const buys = groupItems(s.source_variants, s.sourceSelectorType);
    const sourcePhrase = discountPhrase(s.source_operator, s.source_value);
    const getsLines: string[] = [];
    let getsCount = 0;
    for (const t of s.targets) {
      const g = groupItems(t.target_variants, t.targetSelectorType);
      const tp = discountPhrase(t.target_operator, t.target_value);
      getsLines.push(...g.lines.map((n) => `${n} — ${tp}`));
      getsCount += g.count;
    }
    const min = s.min_qty ? parseInt(s.min_qty, 10) : 0;
    const rows: [string, string][] = [
      ['Qualifying products get', sourcePhrase],
      ['Discount from', `the ${applyFromLabel(s.apply_to)}`],
      ['Minimum to buy', min > 0 ? String(min) : 'No minimum'],
    ];
    if (s.quantity_dependent) rows.push(['Discounted per qualifying item', String(s.target_per_source || 1)]);
    rows.push(['If several qualify', `Discount ${strategyLabel(s.selectionStrategy)}`]);
    rows.push(['Checkout message', s.message ? `“${s.message}”` : '—']);
    return {
      title: `Offer ${i + 1}`,
      badges: [sourcePhrase, platformLabel(formData.platform)],
      headline: `Buy ${min > 0 ? `${min}+ ` : ''}of the qualifying products (${sourcePhrase}) and unlock discounts on the paired products too.`,
      columns: [
        { label: 'Shopper buys', sublabel: sourcePhrase, lines: buys.lines, count: buys.count },
        { label: 'Also discounted', lines: getsLines, count: getsCount },
      ],
      rows,
    };
  });
}

export function ReviewSummary({ formData }: { formData: FormData }) {
  let offers: Offer[];
  let sharedLine: string | null = null;
  if (formData.ruleType === 'bundle-discount') {
    offers = buildBundleOffers(formData);
  } else if (formData.ruleType === 'special_discount') {
    offers = buildSpecialOffers(formData);
  } else {
    offers = buildTierOffers(formData);
    sharedLine = `All levels: discount from the ${applyFromLabel(formData.applyTo)} · applies to ${strategyLabel(
      formData.productDiscountSelectionStrategy,
    )} · works ${platformLabel(formData.platform).toLowerCase()}${formData.message ? ` · shown as “${formData.message}”` : ''}.`;
  }

  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">
        Here’s what shoppers will get
      </Text>
      {sharedLine && (
        <Text as="p" variant="bodySm" tone="subdued">
          {sharedLine}
        </Text>
      )}
      {offers.length > 0 ? (
        offers.map((offer, i) => <OfferCard key={i} {...offer} />)
      ) : (
        <Text as="p" variant="bodySm" tone="subdued">
          Nothing configured yet.
        </Text>
      )}
    </BlockStack>
  );
}
