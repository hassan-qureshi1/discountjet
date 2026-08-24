import { useEffect, useState } from 'react';
import { BlockStack, Box, Card, Text, TextField } from '@shopify/polaris';
import type { DiscountType } from '../../types';
import { SegmentedControl } from '../common/SegmentedControl';
import { DiscountFunctionSettings } from './DiscountFunctionSettings';
import type { RuleType } from './discountForm';

const RULE_FROM_KIND: Record<string, RuleType> = {
  Tier: 'tier-discount',
  Bundle: 'bundle-discount',
  Split: 'special_discount',
};
const TYPE_FROM_KIND: Record<string, DiscountType> = { Tier: 'Tier', Bundle: 'Bundle', Split: 'Special' };
const SYMBOL: Record<DiscountType, string> = { Tier: '%', Bundle: '◱', Special: '◨' };

/** What a completed setup produces — enough to persist a Discount row. */
export interface BuiltDiscount {
  name: string;
  type: DiscountType;
  symbol: string;
  products: number;
}

/**
 * The shared discount-setup body: method + title + the discount-ui wizard.
 * Reports the current built discount up via `onChange` so the host (the
 * Discounts create page, or the campaign modal) can persist it on save.
 */
export function DiscountSetupForm({
  kind,
  defaultTitle = 'New discount',
  onChange,
}: {
  kind: string;
  defaultTitle?: string;
  onChange: (built: BuiltDiscount) => void;
}) {
  const initialRuleType = RULE_FROM_KIND[kind] ?? 'tier-discount';
  const type = TYPE_FROM_KIND[kind] ?? 'Tier';

  const [method, setMethod] = useState(0);
  const [title, setTitle] = useState(defaultTitle);
  const [products, setProducts] = useState(0);

  useEffect(() => {
    onChange({ name: title.trim() || defaultTitle, type, symbol: SYMBOL[type], products });
  }, [title, products, type, defaultTitle, onChange]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <BlockStack gap="150">
            <Text as="span" variant="bodyMd">
              Method
            </Text>
            <SegmentedControl options={['Automatic discount', 'Discount code']} selected={method} onChange={setMethod} />
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

      <Card>
        <BlockStack gap="300">
          <Text as="span" variant="bodySm" tone="subdued">
            Function settings · discount setup
          </Text>
          <Box background="bg-surface-secondary" padding="400" borderRadius="300" borderWidth="025" borderColor="border">
            <DiscountFunctionSettings
              initialRuleType={initialRuleType}
              onSummaryChange={(s) => setProducts(s.products)}
            />
          </Box>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
