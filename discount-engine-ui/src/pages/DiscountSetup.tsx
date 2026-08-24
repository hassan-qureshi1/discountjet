import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BlockStack, Button, ButtonGroup, Card, InlineGrid, Page, Text, TextField } from '@shopify/polaris';
import { useAddDiscount, useDiscount, useUpdateDiscount } from '../store/useDiscountStore';
import type { DiscountType } from '../types';
import { DiscountSetupForm, type BuiltDiscount } from '../components/discount/DiscountSetupForm';

const TYPE_LABEL: Record<string, string> = {
  Tier: 'Volume discount',
  Bundle: 'Buy X, get Y',
  Split: 'Buy X, discount both',
};
// Reverse of the setup form's kind → engine-type mapping, for edit mode.
const KIND_FROM_TYPE: Record<DiscountType, string> = { Tier: 'Tier', Bundle: 'Bundle', Special: 'Split' };

export default function DiscountSetup() {
  const navigate = useNavigate();
  const addDiscount = useAddDiscount();
  const updateDiscount = useUpdateDiscount();
  const [params] = useSearchParams();
  const { id } = useParams();
  const editing = useDiscount(id);
  const isEdit = Boolean(editing);

  const kind = editing ? KIND_FROM_TYPE[editing.type] : (params.get('type') ?? '');
  const discountLabel = TYPE_LABEL[kind] ?? 'Volume discount';
  const backTo = isEdit ? '/shopify-discounts' : '/discounts';

  const [built, setBuilt] = useState<BuiltDiscount>({
    name: editing?.name ?? 'New discount',
    type: editing?.type ?? 'Tier',
    symbol: editing?.symbol ?? '%',
    products: editing?.products ?? 0,
  });

  const save = () => {
    if (editing) {
      updateDiscount(editing.id, {
        name: built.name,
        type: built.type,
        symbol: built.symbol,
        products: built.products,
        updated: 'just now',
      });
    } else {
      addDiscount({
        id: `d-${Date.now()}`,
        name: built.name,
        symbol: built.symbol,
        type: built.type,
        status: 'Active',
        products: built.products,
        updated: 'just now',
      });
    }
    navigate(backTo);
  };

  return (
    <Page
      backAction={{ content: isEdit ? 'Discounts' : 'Discounts', onAction: () => navigate(backTo) }}
      title={isEdit ? 'Edit discount' : 'Create discount'}
      subtitle={discountLabel}
      primaryAction={{ content: isEdit ? 'Save changes' : 'Save discount', onAction: save }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate(backTo) }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <DiscountSetupForm
          kind={kind}
          defaultTitle={editing?.name ?? 'Buy 2 Pillows, save 15%'}
          prefill={isEdit}
          onChange={setBuilt}
        />

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
              {isEdit && (
                <Text as="span" variant="bodySm" tone="subdued">
                  Editing a synced Shopify discount.
                </Text>
              )}
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
