// web/Pages/DiscountDetail.tsx
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge, Banner, BlockStack, Box, Button, Card, InlineGrid, InlineStack, Page, Spinner, Text,
} from '@shopify/polaris';
import { useDiscountQuery } from '../discounts/hooks';
import { DISCOUNT_TYPE_LABEL } from '../types/discounts';
import { KeyValueList } from '../components/KeyValueList';
import { SymbolTile } from '../components/SymbolTile';

const DESCRIPTIONS: Record<string, string> = {
  Tier: 'Once a shopper adds enough qualifying items, the discount applies automatically. Works at POS & Checkout, on every eligible item.',
  Bundle: 'When the qualifying and rewarded items are in the cart together, the discount applies to the products you chose.',
  Special: 'Buying the qualifying items discounts the paired items too — great for “main item + add-on” deals.',
};

export default function DiscountDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDiscountQuery(id);
  const discount = data?.discount;
  const campaign = data?.campaign ?? undefined;
  const isNotFound = error ? /failed: 404\b/.test(error.message) : false;

  if (isLoading) {
    return (
      <Page title="Discount" backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}>
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spinner accessibilityLabel="Loading discount" />
        </div>
      </Page>
    );
  }

  if (error && !isNotFound) {
    return (
      <Page title="Discount" backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}>
        <Banner tone="critical">{error.message}</Banner>
      </Page>
    );
  }

  if (!discount) {
    return (
      <Page title="Discount not found" backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}>
        <Card><Text as="p">This discount doesn’t exist. It may have been deleted in Shopify.</Text></Card>
      </Page>
    );
  }

  const isActive = discount.status === 'Active';
  const locked = Boolean(discount.campaignId);

  return (
    <Page
      backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}
      title={discount.name}
      titleMetadata={(
        <InlineStack gap="150">
          <Badge tone="magic">{DISCOUNT_TYPE_LABEL[discount.type]}</Badge>
          {locked && <Badge tone="info">Campaign-owned</Badge>}
        </InlineStack>
      )}
      subtitle={locked ? 'Created by a campaign · read-only' : 'Synced from Shopify via webhook · read-only'}
      secondaryActions={[{ content: 'View in Shopify' }]}
    >
      <BlockStack gap="400">
        {locked && (
          <Banner
            tone="warning"
            title={`This discount belongs to the “${campaign?.name ?? 'campaign'}” campaign`}
            action={campaign ? { content: 'Open campaign', onAction: () => navigate(`/campaigns/${campaign.id}`) } : undefined}
          >
            <p>Changing it here would drift from what shoppers see in the campaign, so its fields are locked. Edit it by cloning the campaign into a new draft.</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">What this discount does</Text>
                  {locked && <Badge tone="attention">🔒 Locked</Badge>}
                </InlineStack>
                <Text as="p" variant="bodyMd">{DESCRIPTIONS[discount.type]}</Text>
                <KeyValueList
                  items={[
                    { term: 'Discount type', description: DISCOUNT_TYPE_LABEL[discount.type] },
                    { term: 'Applies', description: 'POS & Checkout' },
                    { term: 'Products touched', description: `${discount.products} variants` },
                    { term: 'Status', description: <Badge tone={isActive ? 'success' : undefined}>{discount.status}</Badge> },
                    locked
                      ? { term: 'Campaign', description: campaign?.name ?? '—' }
                      : { term: 'Last synced', description: `${discount.updated} (discounts/update)` },
                  ]}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">Storefront upsell</Text>
                  <Badge tone="success">Shown</Badge>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {locked ? 'This discount’s upsell is managed by its campaign.' : 'When on, the products in this discount appear as an upsell card on the storefront.'}
                </Text>
                <InlineStack gap="300" blockAlign="center">
                  <Button variant="primary" disabled={locked} onClick={() => navigate(`/discounts/${discount.id}/upsell`)}>
                    Design upsell card
                  </Button>
                  {!locked && <Text as="span" variant="bodySm" tone="subdued">Customise the card shoppers see for this discount.</Text>}
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Upsell preview</Text>
              <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <SymbolTile symbol="🛌" size={40} emoji />
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">Memory Foam Pillow</Text>
                    <InlineStack gap="150" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="bold">$67.15</Text>
                      <Text as="span" variant="bodySm" tone="subdued" textDecorationLine="line-through">$79.00</Text>
                      <Badge tone="success">−15%</Badge>
                    </InlineStack>
                  </BlockStack>
                </InlineStack>
              </Box>
              <Text as="p" variant="bodySm" tone="subdued">Strike price is derived from this discount’s config.</Text>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
