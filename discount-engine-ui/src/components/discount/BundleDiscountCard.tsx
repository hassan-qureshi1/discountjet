import {
  BlockStack,
  Box,
  Button,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import type { BundleDiscount, Operator, SelectorType, Strategy } from './discountForm';
import { ProductPicker } from './ProductPicker';

type Field = keyof BundleDiscount;

export function BundleDiscountCard({
  bundle,
  bundleIndex,
  section,
  canRemove,
  onUpdate,
  onRemove,
}: {
  bundle: BundleDiscount;
  bundleIndex: number;
  section: 'products' | 'rules';
  canRemove: boolean;
  onUpdate: (field: Field, value: string | boolean) => void;
  onRemove: () => void;
}) {
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <Text as="h4" variant="headingSm">
            Offer {bundleIndex + 1}
          </Text>
          {canRemove && (
            <Button tone="critical" variant="tertiary" onClick={onRemove}>
              Remove
            </Button>
          )}
        </InlineStack>

        {section === 'rules' && (
          <>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <Select
                requiredIndicator
                label="Discount type"
                options={[
                  { label: 'Percentage off', value: 'percentage' },
                  { label: 'Fixed amount off', value: 'amount' },
                ]}
                value={bundle.operator}
                onChange={(v) => onUpdate('operator', v as Operator)}
              />
              <TextField
                requiredIndicator
                label={bundle.operator === 'percentage' ? 'Discount percentage' : 'Discount amount'}
                type="number"
                value={bundle.value}
                onChange={(v) => onUpdate('value', v)}
                suffix={bundle.operator === 'percentage' ? '%' : '$'}
                min={0}
                max={bundle.operator === 'percentage' ? 100 : undefined}
                autoComplete="off"
              />
              <Select
                label="Discount from"
                options={[
                  { label: 'Selling price', value: 'price' },
                  { label: 'Original (compare-at) price', value: 'compare_at_price' },
                ]}
                value={bundle.apply_to}
                onChange={(v) => onUpdate('apply_to', v)}
              />
            </InlineGrid>

            <TextField
              label="Message shown to shoppers"
              value={bundle.message}
              onChange={(v) => onUpdate('message', v)}
              placeholder="e.g. 20% off"
              autoComplete="off"
            />

            <Divider />
            <Checkbox
              label="Limit how many items are discounted"
              checked={bundle.quantity_dependent}
              onChange={(checked) => onUpdate('quantity_dependent', checked)}
              helpText="Tie the number of discounted items to how many qualifying items are bought."
            />

            {bundle.quantity_dependent ? (
              <>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <TextField
                    label="Minimum quantity to buy"
                    type="number"
                    value={bundle.min_qty}
                    onChange={(v) => onUpdate('min_qty', v)}
                    placeholder="No minimum"
                    min={0}
                    autoComplete="off"
                  />
                  <TextField
                    label="Discounted items per qualifying item"
                    type="number"
                    value={bundle.target_per_source}
                    onChange={(v) => onUpdate('target_per_source', v)}
                    min={1}
                    autoComplete="off"
                    helpText="e.g. 2 = buy 1, get 2 discounted."
                  />
                </InlineGrid>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <Checkbox
                    label="Require exact sets"
                    checked={bundle.fixed_ratios}
                    onChange={(checked) => onUpdate('fixed_ratios', checked)}
                    helpText="Only discount when the cart holds complete sets."
                  />
                  <Checkbox
                    label="Share the discount limit across products"
                    checked={bundle.shared_pool}
                    onChange={(checked) => onUpdate('shared_pool', checked)}
                    helpText="On: the discounted quantity is shared across all discounted products."
                  />
                </InlineGrid>
                <TextField
                  label="Maximum discounted items"
                  type="number"
                  value={bundle.max_target_qty}
                  onChange={(v) => onUpdate('max_target_qty', v)}
                  placeholder="Optional"
                  min={1}
                  disabled={!bundle.fixed_ratios}
                  autoComplete="off"
                  helpText="Optional cap on how many items can be discounted (used with “Require exact sets”)."
                />
              </>
            ) : (
              <TextField
                label="Minimum quantity to buy"
                type="number"
                value={bundle.min_qty}
                onChange={(v) => onUpdate('min_qty', v)}
                placeholder="No minimum"
                min={0}
                autoComplete="off"
                helpText="The smallest number of qualifying items a shopper must buy for this offer to apply."
              />
            )}

            <Select
              label="If several products qualify"
              options={[
                { label: 'Discount them all', value: 'ALL' },
                { label: 'Discount the first one', value: 'FIRST' },
                { label: 'Discount the best-value one', value: 'MAXIMUM' },
              ]}
              value={bundle.selectionStrategy}
              onChange={(v) => onUpdate('selectionStrategy', v as Strategy)}
            />
          </>
        )}

        {section === 'products' && (
          <>
            <Text as="h4" variant="headingSm">
              Products the shopper must buy
            </Text>
            <Select
              label="Match products by"
              options={[
                { label: 'Specific variants', value: 'variant_id' },
                { label: 'Whole products', value: 'product_id' },
              ]}
              value={bundle.sourceSelectorType}
              onChange={(v) => {
                onUpdate('sourceSelectorType', v as SelectorType);
                onUpdate('source_variants', '[]');
              }}
            />
            <ProductPicker
              label="Choose qualifying products"
              requiredIndicator
              selectorType={bundle.sourceSelectorType}
              json={bundle.source_variants}
              onChange={(json) => onUpdate('source_variants', json)}
            />

            <Divider />
            <Text as="h4" variant="headingSm">
              Products that get the discount
            </Text>
            <Select
              label="Match products by"
              options={[
                { label: 'Specific variants', value: 'variant_id' },
                { label: 'Whole products', value: 'product_id' },
              ]}
              value={bundle.targetSelectorType}
              onChange={(v) => {
                onUpdate('targetSelectorType', v as SelectorType);
                onUpdate('target_variants', '[]');
              }}
            />
            <ProductPicker
              label="Choose discounted products"
              requiredIndicator
              selectorType={bundle.targetSelectorType}
              json={bundle.target_variants}
              onChange={(json) => onUpdate('target_variants', json)}
            />
          </>
        )}
      </BlockStack>
    </Box>
  );
}
