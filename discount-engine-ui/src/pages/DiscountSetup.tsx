import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BlockStack, Button, ButtonGroup, Card, InlineGrid, Page, Text, TextField } from '@shopify/polaris';
import { useAddDiscount } from '../store/useDiscountStore';
import { DiscountSetupForm, type BuiltDiscount } from '../components/discount/DiscountSetupForm';

const TYPE_LABEL: Record<string, string> = {
  Tier: 'Volume discount',
  Bundle: 'Buy X, get Y',
  Split: 'Buy X, discount both',
};

export default function DiscountSetup() {
  const navigate = useNavigate();
  const addDiscount = useAddDiscount();
  const [params] = useSearchParams();
  const kind = params.get('type') ?? '';
  const discountLabel = TYPE_LABEL[kind] ?? 'Volume discount';

  const [built, setBuilt] = useState<BuiltDiscount>({ name: 'New discount', type: 'Tier', symbol: '%', products: 0 });

  const save = () => {
    addDiscount({
      id: `d-${Date.now()}`,
      name: built.name,
      symbol: built.symbol,
      type: built.type,
      status: 'Active',
      products: built.products,
      updated: 'just now',
    });
    navigate('/discounts');
  };

  return (
    <Page
      backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}
      title="Create discount"
      subtitle={discountLabel}
      primaryAction={{ content: 'Save discount', onAction: save }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate('/discounts') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <DiscountSetupForm kind={kind} defaultTitle="Buy 2 Pillows, save 15%" onChange={setBuilt} />

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Summary
              </Text>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {built.name}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {discountLabel} · {built.products} product{built.products === 1 ? '' : 's'}
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Active dates
              </Text>
              <InlineGrid columns={2} gap="300">
                <TextField label="Start date" value="2026-08-14" onChange={() => undefined} autoComplete="off" />
                <TextField label="Start time (AEST)" value="09:00" onChange={() => undefined} autoComplete="off" />
              </InlineGrid>
              <ButtonGroup>
                <Button>Set end date</Button>
              </ButtonGroup>
            </BlockStack>
          </Card>
        </BlockStack>
      </InlineGrid>
    </Page>
  );
}
