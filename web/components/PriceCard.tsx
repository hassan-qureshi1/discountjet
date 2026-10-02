import type { ReactNode } from 'react';
import {
  Badge, BlockStack, Card, InlineGrid, InlineStack, Text, TextField,
} from '@shopify/polaris';

export interface PriceCardProps {
  title: string;
  /** Optional paragraph under the heading, explaining what the price does. */
  description?: string;

  label: string;
  labelHidden?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** The shop's currency symbol, or undefined while it is unknown. */
  prefix?: string;
  placeholder?: string;
  helpText?: string;

  /**
   * The total this price is being compared against — already FORMATTED by the
   * caller. Money formatting needs the shop's currency and its own em-dash
   * rules for "unknown"; keeping it out here is what stops this card growing a
   * second opinion about how money is displayed.
   */
  comparison: string;
  comparisonLabel?: string;

  /**
   * The saving to celebrate, already formatted, or null for none. Whether a
   * saving is meaningful is a domain rule — an optional price that is blank
   * has no saving to claim — so the caller decides and this card only renders.
   */
  saving?: string | null;

  /** Disables the price input. */
  disabled?: boolean;
  /** Extra content rendered under the price row, inside the same card. */
  footer?: ReactNode;
}

/**
 * A price input beside the total it is discounted from, with the saving
 * badged. Used by any screen that sets one price against a reference total —
 * bundle pricing today, campaign pricing next.
 */
export function PriceCard({
  title,
  description,
  label,
  labelHidden,
  value,
  onChange,
  prefix,
  placeholder,
  helpText,
  comparison,
  comparisonLabel = 'Sum of items',
  saving = null,
  disabled,
  footer,
}: PriceCardProps) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">{title}</Text>
        {description && (
          <Text as="span" variant="bodySm" tone="subdued">{description}</Text>
        )}
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label={label}
            labelHidden={labelHidden}
            type="number"
            prefix={prefix}
            value={value}
            onChange={onChange}
            autoComplete="off"
            min={0}
            placeholder={placeholder}
            helpText={helpText}
            disabled={disabled}
          />
          <BlockStack gap="100">
            <Text as="span" variant="bodyMd">{comparisonLabel}</Text>
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd" tone="subdued" textDecorationLine="line-through">
                {comparison}
              </Text>
              {saving && <Badge tone="success">{`Save ${saving}`}</Badge>}
            </InlineStack>
          </BlockStack>
        </InlineGrid>
        {footer}
      </BlockStack>
    </Card>
  );
}
