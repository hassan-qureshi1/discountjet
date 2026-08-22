import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  InlineGrid,
  Page,
  Text,
  TextField,
} from '@shopify/polaris';
import { SegmentedControl } from '../components/common/SegmentedControl';
import { DiscountFunctionSettings } from '../components/discount/DiscountFunctionSettings';
import type { RuleType } from '../components/discount/discountForm';

const TYPE_LABEL: Record<string, string> = {
  Tier: 'Tier discount',
  Bundle: 'Bundle discount',
  Split: 'Split bundle discount',
};
const RULE_FROM_KIND: Record<string, RuleType> = {
  Tier: 'tier-discount',
  Bundle: 'bundle-discount',
  Split: 'special_discount',
};

export default function DiscountSetup() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const kind = params.get('type') ?? '';
  const discountLabel = TYPE_LABEL[kind] ?? 'Volume discount';
  const initialRuleType = RULE_FROM_KIND[kind] ?? 'tier-discount';

  const [method, setMethod] = useState(0);
  const [title, setTitle] = useState('Buy 2 Pillows, save 15%');

  return (
    <Page
      backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}
      title="Create discount"
      subtitle={`Discount Engine · ${discountLabel}`}
      primaryAction={{ content: 'Save discount' }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate('/discounts') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="150">
                <Text as="span" variant="bodyMd">
                  Method
                </Text>
                <SegmentedControl
                  options={['Automatic discount', 'Discount code']}
                  selected={method}
                  onChange={setMethod}
                />
              </BlockStack>
              <TextField
                label="Title"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                helpText="Customers see this in their cart and at checkout."
              />
            </BlockStack>
          </Card>

          {/* Function settings · discount-ui extension (faithful port) */}
          <Card>
            <BlockStack gap="300">
              <Text as="span" variant="bodySm" tone="subdued">
                Function settings · discount-ui
              </Text>
              <Box
                background="bg-surface-secondary"
                padding="400"
                borderRadius="300"
                borderWidth="025"
                borderColor="border"
              >
                <DiscountFunctionSettings initialRuleType={initialRuleType} />
              </Box>
            </BlockStack>
          </Card>
        </BlockStack>

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Summary
              </Text>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {title}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                Discount Engine · {discountLabel}
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
