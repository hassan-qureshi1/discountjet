import { BlockStack, Button, InlineStack, Tag, Text } from '@shopify/polaris';
import {
  chipLabel,
  itemKey,
  parseItems,
  pickNext,
  type ProductItem,
  type SelectorType,
  type VariantItem,
} from './discountForm';

/**
 * "Choose products" button + removable chips of the current selection.
 * Stands in for the extension's shopify.resourcePicker using SAMPLE data.
 */
export function ProductPicker({
  label,
  selectorType,
  json,
  onChange,
}: {
  label: string;
  selectorType: SelectorType;
  json: string;
  onChange: (json: string) => void;
}) {
  const items = parseItems<VariantItem | ProductItem>(json);

  const remove = (key: string) => {
    const next = items.filter((it) => itemKey(it) !== key);
    onChange(JSON.stringify(next));
  };

  return (
    <BlockStack gap="200">
      <Button onClick={() => onChange(pickNext(json, selectorType))}>{label}</Button>
      {items.length > 0 && (
        <BlockStack gap="150">
          <Text as="span" variant="bodySm">
            Chosen products ({items.length})
          </Text>
          <InlineStack gap="150">
            {items.map((item) => (
              <Tag key={itemKey(item)} onRemove={() => remove(itemKey(item))}>
                {chipLabel(item)}
              </Tag>
            ))}
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
  );
}
