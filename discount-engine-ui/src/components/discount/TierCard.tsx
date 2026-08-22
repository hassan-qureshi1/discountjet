import { BlockStack, Box, Button, InlineGrid, InlineStack, Select, Text, TextField } from '@shopify/polaris';
import type { Operator, SelectorType, Tier } from './discountForm';
import { ProductPicker } from './ProductPicker';

export function TierCard({
  tier,
  tierIndex,
  discountType,
  canRemove,
  onUpdate,
  onRemove,
}: {
  tier: Tier;
  tierIndex: number;
  discountType: Operator;
  canRemove: boolean;
  onUpdate: (field: keyof Tier, value: string) => void;
  onRemove: () => void;
}) {
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <Text as="h4" variant="headingSm">
            Savings level {tierIndex + 1}
          </Text>
          {canRemove && (
            <Button tone="critical" variant="tertiary" onClick={onRemove}>
              Remove
            </Button>
          )}
        </InlineStack>

        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label={discountType === 'percentage' ? 'Discount percentage' : 'Discount amount'}
            type="number"
            value={tier.value}
            onChange={(v) => onUpdate('value', v)}
            suffix={discountType === 'percentage' ? '%' : '$'}
            min={0}
            max={discountType === 'percentage' ? 100 : undefined}
            autoComplete="off"
          />
          <TextField
            label="Minimum quantity to unlock"
            type="number"
            value={tier.min_qty}
            onChange={(v) => onUpdate('min_qty', v)}
            placeholder="No minimum"
            min={0}
            autoComplete="off"
            helpText="How many of these products a shopper needs before this level applies."
          />
        </InlineGrid>

        <Select
          label="Match products by"
          options={[
            { label: 'Specific variants', value: 'variant_id' },
            { label: 'Whole products', value: 'product_id' },
          ]}
          value={tier.selectorType}
          helpText="Match specific variants (e.g. one size/colour) or the whole product across all its variants."
          onChange={(value) => {
            onUpdate('selectorType', value as SelectorType);
            onUpdate('targets', '[]');
          }}
        />

        <ProductPicker
          label="Choose products"
          selectorType={tier.selectorType}
          json={tier.targets}
          onChange={(json) => onUpdate('targets', json)}
        />
      </BlockStack>
    </Box>
  );
}
