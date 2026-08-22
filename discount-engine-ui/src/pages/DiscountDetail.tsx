import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useDiscount } from '../store/useDiscountStore';
import { KeyValueList } from '../components/common/KeyValueList';
import { SymbolTile } from '../components/common/SymbolTile';

const DESCRIPTIONS: Record<string, string> = {
  Tier: 'Once a shopper adds enough qualifying items, the tier discount applies automatically. Works at POS & Checkout, on every eligible item.',
  Bundle: 'When the source and target items are in the cart together, the bundle price applies. Assembled by the Rust bundle function at checkout.',
  Special: 'A split/BOGO offer — buying the trigger items discounts the reward items. Evaluated by the Rust special function at checkout.',
};

export default function DiscountDetail() {
  const { id } = useParams();
  const discount = useDiscount(id);
  const navigate = useNavigate();

  if (!discount) {
    return (
      <Page title="Discount not found" backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}>
        <Card>
          <Text as="p">This discount doesn’t exist. It may have been deleted in Shopify.</Text>
        </Card>
      </Page>
    );
  }

  const isActive = discount.status === 'Active';

  return (
    <Page
      backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}
      title={discount.name}
      titleMetadata={<Badge tone="magic">{discount.type}</Badge>}
      subtitle="Synced from Shopify via webhook · read-only config"
      secondaryActions={[{ content: 'View in Shopify' }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                What this discount does
              </Text>
              <Text as="p" variant="bodyMd">
                {DESCRIPTIONS[discount.type]}
              </Text>
              <KeyValueList
                items={[
                  { term: 'Discount type', description: `${discount.type} discount` },
                  { term: 'Applies', description: 'POS & Checkout' },
                  { term: 'Products touched', description: `${discount.products} variants` },
                  {
                    term: 'Status',
                    description: <Badge tone={isActive ? 'success' : undefined}>{discount.status}</Badge>,
                  },
                  { term: 'Last synced', description: `${discount.updated} (discounts/update)` },
                ]}
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Storefront upsell
                </Text>
                <Badge tone="success">Shown</Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                When on, the products in this discount appear as an upsell card on the storefront.
              </Text>
              <InlineStack gap="300" blockAlign="center">
                <Button variant="primary" onClick={() => navigate(`/discounts/${discount.id}/upsell`)}>
                  Design upsell card
                </Button>
                <Text as="span" variant="bodySm" tone="subdued">
                  Customise the card shoppers see for this discount.
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Upsell preview
            </Text>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <InlineStack gap="300" blockAlign="center" wrap={false}>
                <SymbolTile symbol="🛌" size={40} emoji />
                <BlockStack gap="050">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    Memory Foam Pillow
                  </Text>
                  <InlineStack gap="150" blockAlign="center">
                    <Text as="span" variant="bodyMd" fontWeight="bold">
                      $67.15
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued" textDecorationLine="line-through">
                      $79.00
                    </Text>
                    <Badge tone="success">−15%</Badge>
                  </InlineStack>
                </BlockStack>
              </InlineStack>
            </Box>
            <Text as="p" variant="bodySm" tone="subdued">
              Strike price is derived from this discount’s config.
            </Text>
          </BlockStack>
        </Card>
      </InlineGrid>
    </Page>
  );
}
