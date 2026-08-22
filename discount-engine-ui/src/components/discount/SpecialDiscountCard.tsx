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
import {
  newSpecialTarget,
  type Operator,
  type SelectorType,
  type SpecialDiscount,
  type SpecialTarget,
  type Strategy,
} from './discountForm';
import { ProductPicker } from './ProductPicker';

type Field = keyof SpecialDiscount;
type Value = string | boolean | SpecialTarget[];

export function SpecialDiscountCard({
  special,
  discountIndex,
  section,
  canRemove,
  onUpdate,
  onRemove,
}: {
  special: SpecialDiscount;
  discountIndex: number;
  section: 'products' | 'rules';
  canRemove: boolean;
  onUpdate: (field: Field, value: Value) => void;
  onRemove: () => void;
}) {
  const renderRules = section === 'rules';
  const renderProducts = section === 'products';
  const targets = special.targets.length ? special.targets : [newSpecialTarget()];

  const updateTargets = (next: SpecialTarget[]) => onUpdate('targets', next);
  const updateTarget = (ti: number, field: keyof SpecialTarget, value: string) =>
    updateTargets(targets.map((t, i) => (i === ti ? { ...t, [field]: value } : t)));
  const addTarget = () => updateTargets([...targets, newSpecialTarget()]);
  const removeTarget = (ti: number) => updateTargets(targets.filter((_, i) => i !== ti));

  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <Text as="h4" variant="headingSm">
            Offer {discountIndex + 1}
          </Text>
          {canRemove && (
            <Button tone="critical" variant="tertiary" onClick={onRemove}>
              Remove
            </Button>
          )}
        </InlineStack>

        {renderRules && (
          <>
            <Select
              label="Discount from"
              options={[
                { label: 'Selling price', value: 'price' },
                { label: 'Original (compare-at) price', value: 'compare_at_price' },
              ]}
              value={special.apply_to}
              onChange={(v) => onUpdate('apply_to', v)}
            />
            <TextField
              label="Message shown to shoppers"
              value={special.message}
              onChange={(v) => onUpdate('message', v)}
              placeholder="e.g. 20% off"
              autoComplete="off"
            />
            <Divider />
            <Checkbox
              label="Limit how many items are discounted"
              checked={special.quantity_dependent}
              onChange={(checked) => onUpdate('quantity_dependent', checked)}
              helpText="Tie the number of discounted items to how many qualifying items are bought."
            />
            {special.quantity_dependent ? (
              <>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <TextField label="Minimum quantity to buy" type="number" value={special.min_qty} onChange={(v) => onUpdate('min_qty', v)} placeholder="No minimum" min={0} autoComplete="off" />
                  <TextField label="Discounted items per qualifying item" type="number" value={special.target_per_source} onChange={(v) => onUpdate('target_per_source', v)} min={1} autoComplete="off" />
                </InlineGrid>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <Checkbox label="Require exact sets" checked={special.fixed_ratios} onChange={(checked) => onUpdate('fixed_ratios', checked)} />
                  <Checkbox label="Share the discount limit across products" checked={special.shared_pool} onChange={(checked) => onUpdate('shared_pool', checked)} />
                </InlineGrid>
              </>
            ) : (
              <TextField label="Minimum quantity to buy" type="number" value={special.min_qty} onChange={(v) => onUpdate('min_qty', v)} placeholder="No minimum" min={0} autoComplete="off" />
            )}
            <Select
              label="If several products qualify"
              options={[
                { label: 'Discount them all', value: 'ALL' },
                { label: 'Discount the first one', value: 'FIRST' },
                { label: 'Discount the best-value one', value: 'MAXIMUM' },
              ]}
              value={special.selectionStrategy}
              onChange={(v) => onUpdate('selectionStrategy', v as Strategy)}
            />

            <Divider />
            <Text as="h4" variant="headingSm">
              Discount for the qualifying products
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <Select
                label="Discount type"
                options={[
                  { label: 'Percentage off', value: 'percentage' },
                  { label: 'Fixed amount off', value: 'amount' },
                ]}
                value={special.source_operator}
                onChange={(v) => onUpdate('source_operator', v as Operator)}
              />
              <TextField
                label={special.source_operator === 'percentage' ? 'Discount percentage' : 'Discount amount'}
                type="number"
                value={special.source_value}
                onChange={(v) => onUpdate('source_value', v)}
                suffix={special.source_operator === 'percentage' ? '%' : '$'}
                min={0}
                max={special.source_operator === 'percentage' ? 100 : undefined}
                autoComplete="off"
              />
              <TextField label="Message for these products" value={special.source_message} onChange={(v) => onUpdate('source_message', v)} placeholder="e.g. Main item 20% off" autoComplete="off" />
            </InlineGrid>
          </>
        )}

        {renderProducts && (
          <>
            <Divider />
            <Text as="h4" variant="headingSm">
              Products the shopper must buy
            </Text>
            <Select
              label="Match products by"
              options={[
                { label: 'Specific variants', value: 'variant_id' },
                { label: 'Whole products', value: 'product_id' },
              ]}
              value={special.sourceSelectorType}
              onChange={(v) => {
                onUpdate('sourceSelectorType', v as SelectorType);
                onUpdate('source_variants', '[]');
              }}
            />
            <ProductPicker
              label="Choose qualifying products"
              selectorType={special.sourceSelectorType}
              json={special.source_variants}
              onChange={(json) => onUpdate('source_variants', json)}
            />
          </>
        )}

        <Divider />

        {targets.map((target, ti) => (
          <Box key={ti} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
            <BlockStack gap="300">
              <InlineStack gap="300" blockAlign="center">
                <Text as="h4" variant="headingSm">
                  Discounted set {ti + 1}
                </Text>
                {targets.length > 1 && (
                  <Button tone="critical" variant="tertiary" onClick={() => removeTarget(ti)}>
                    Remove
                  </Button>
                )}
              </InlineStack>

              {renderRules && (
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <Select
                    label="Discount type"
                    options={[
                      { label: 'Percentage off', value: 'percentage' },
                      { label: 'Fixed amount off', value: 'amount' },
                    ]}
                    value={target.target_operator}
                    onChange={(v) => updateTarget(ti, 'target_operator', v)}
                  />
                  <TextField
                    label={target.target_operator === 'percentage' ? 'Discount percentage' : 'Discount amount'}
                    type="number"
                    value={target.target_value}
                    onChange={(v) => updateTarget(ti, 'target_value', v)}
                    suffix={target.target_operator === 'percentage' ? '%' : '$'}
                    min={0}
                    max={target.target_operator === 'percentage' ? 100 : undefined}
                    autoComplete="off"
                  />
                  <TextField label="Message for these products" value={target.target_message} onChange={(v) => updateTarget(ti, 'target_message', v)} placeholder="e.g. Bonus item 30% off" autoComplete="off" />
                </InlineGrid>
              )}

              {renderProducts && (
                <>
                  <Select
                    label="Match products by"
                    options={[
                      { label: 'Specific variants', value: 'variant_id' },
                      { label: 'Whole products', value: 'product_id' },
                    ]}
                    value={target.targetSelectorType}
                    onChange={(v) => {
                      updateTargets(
                        targets.map((t, i) =>
                          i === ti ? { ...t, targetSelectorType: v as SelectorType, target_variants: '[]' } : t,
                        ),
                      );
                    }}
                  />
                  <ProductPicker
                    label="Choose discounted products"
                    selectorType={target.targetSelectorType}
                    json={target.target_variants}
                    onChange={(json) => updateTarget(ti, 'target_variants', json)}
                  />
                </>
              )}
            </BlockStack>
          </Box>
        ))}

        {renderProducts && (
          <InlineStack gap="300" blockAlign="center">
            <Text as="h4" variant="headingSm">
              Products that get the discount
            </Text>
            <Button onClick={addTarget}>Add another set</Button>
          </InlineStack>
        )}
      </BlockStack>
    </Box>
  );
}
