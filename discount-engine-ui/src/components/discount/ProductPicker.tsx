import { BlockStack, Button, InlineStack, Labelled, Text } from '@shopify/polaris';
import {
  chipLabel,
  itemKey,
  parseItems,
  pickNext,
  productEmoji,
  type ProductItem,
  type SelectorType,
  type VariantItem,
} from './discountForm';

/** A chosen-product pill with a small product image (emoji thumbnail) + remove. */
function ProductChip({
  emoji,
  label,
  onRemove,
}: {
  emoji: string;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--p-color-bg-surface-secondary)',
        border: '1px solid var(--p-color-border)',
        borderRadius: 8,
        padding: '3px 8px 3px 4px',
        fontSize: 12.5,
        color: 'var(--p-color-text)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          display: 'grid',
          placeItems: 'center',
          fontSize: 13,
          flex: '0 0 auto',
          background: 'var(--p-color-bg-surface)',
          boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
        }}
      >
        {emoji}
      </span>
      <span>{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        style={{
          border: 'none',
          background: 'none',
          cursor: 'pointer',
          color: 'var(--p-color-icon-secondary)',
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        ✕
      </button>
    </span>
  );
}

/**
 * "Choose products" button + product pills of the current selection.
 * Stands in for the extension's shopify.resourcePicker using SAMPLE data.
 */
export function ProductPicker({
  label,
  selectorType,
  json,
  onChange,
  requiredIndicator = false,
}: {
  label: string;
  selectorType: SelectorType;
  json: string;
  onChange: (json: string) => void;
  requiredIndicator?: boolean;
}) {
  const items = parseItems<VariantItem | ProductItem>(json);

  const remove = (key: string) => {
    const next = items.filter((it) => itemKey(it) !== key);
    onChange(JSON.stringify(next));
  };

  const button = <Button onClick={() => onChange(pickNext(json, selectorType))}>{label}</Button>;

  return (
    <BlockStack gap="200">
      {requiredIndicator ? (
        <Labelled id={`picker-${label}`} label={label} requiredIndicator>
          {button}
        </Labelled>
      ) : (
        button
      )}
      {items.length > 0 && (
        <BlockStack gap="150">
          <Text as="span" variant="bodySm">
            Chosen products ({items.length})
          </Text>
          <InlineStack gap="150">
            {items.map((item) => (
              <ProductChip
                key={itemKey(item)}
                emoji={productEmoji(item)}
                label={chipLabel(item)}
                onRemove={() => remove(itemKey(item))}
              />
            ))}
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
  );
}
