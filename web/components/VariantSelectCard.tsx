import type { ReactNode } from 'react';
import {
  BlockStack, Button, Card, InlineStack, Text,
} from '@shopify/polaris';
import { DeleteIcon } from '@shopify/polaris-icons';

export interface VariantSelectCardProps {
  title: string;
  description?: string;

  /**
   * The chosen variant's label, or null when nothing is chosen.
   *
   * A node rather than a string: resolving a variant id to a display name needs
   * the page's live Admin lookup and its fallbacks for a deleted variant, which
   * is not something this card should know about.
   */
  selectedLabel?: ReactNode;

  /**
   * Links or controls for the chosen variant, shown beside the Change button.
   * A node for the same reason as `selectedLabel` — the card stays unaware of
   * what a variant is.
   */
  selectedActions?: ReactNode;

  /**
   * The chosen variant's own price, with whatever label gives it meaning on
   * this screen. Worth showing wherever the variant's price is the number
   * other fields are validated against: a merchant asked to set a price
   * "below the bundle product's own price" cannot do it without seeing that
   * price, and would otherwise have to open the Shopify admin to find it.
   */
  priceLabel?: ReactNode;

  /** A closing line under the selection — e.g. how it relates to the items. */
  footnote?: ReactNode;

  onRemove: () => void;
  onPick: () => void;

  /** False outside the Shopify admin, where the resource picker cannot open. */
  pickerAvailable?: boolean;

  emptyText?: string;
  chooseLabel?: string;
  changeLabel?: string;
  unavailableText?: string;
  removeLabel?: string;
}

/**
 * Choose exactly one variant, shown as a full row with a picker button.
 *
 * Used wherever a screen needs a single target variant — a bundle's parent
 * line, a merged line's representative variant, and anything later that points
 * at one variant.
 *
 * The selection renders at the same visual weight as the component rows it
 * sits beside, because it is at least as important: it is the line a shopper
 * actually buys. It was previously a Polaris `Tag`, which gave the single most
 * significant object on the screen less presence than the items below it and
 * left no room for the price or the links.
 */
export function VariantSelectCard({
  title,
  description,
  selectedLabel = null,
  selectedActions = null,
  priceLabel = null,
  footnote = null,
  onRemove,
  onPick,
  pickerAvailable = true,
  emptyText = 'No variant chosen.',
  chooseLabel = 'Choose variant',
  changeLabel = 'Change variant',
  unavailableText = 'Product picker is available inside the Shopify admin.',
  removeLabel = 'Remove the chosen variant',
}: VariantSelectCardProps) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">{title}</Text>
        {description && (
          <Text as="span" variant="bodySm" tone="subdued">{description}</Text>
        )}

        {selectedLabel ? (
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
            <BlockStack gap="050">
              {selectedLabel}
              {priceLabel}
            </BlockStack>
            <InlineStack gap="150" blockAlign="center" wrap={false}>
              {selectedActions}
              <Button onClick={onPick} disabled={!pickerAvailable}>
                {changeLabel}
              </Button>
              <Button
                variant="tertiary"
                tone="critical"
                icon={DeleteIcon}
                accessibilityLabel={removeLabel}
                onClick={onRemove}
              />
            </InlineStack>
          </InlineStack>
        ) : (
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">{emptyText}</Text>
            <Button onClick={onPick} disabled={!pickerAvailable}>
              {chooseLabel}
            </Button>
          </InlineStack>
        )}

        {footnote}

        {!pickerAvailable && (
          <Text as="span" variant="bodySm" tone="subdued">{unavailableText}</Text>
        )}
      </BlockStack>
    </Card>
  );
}
