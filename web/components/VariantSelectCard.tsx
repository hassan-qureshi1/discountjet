import type { ReactNode } from 'react';
import {
  BlockStack, Button, Card, InlineStack, Tag, Text,
} from '@shopify/polaris';

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
  onRemove: () => void;
  onPick: () => void;

  /** False outside the Shopify admin, where the resource picker cannot open. */
  pickerAvailable?: boolean;

  emptyText?: string;
  chooseLabel?: string;
  changeLabel?: string;
  unavailableText?: string;
}

/**
 * Choose exactly one variant, shown as a removable tag with a picker button.
 *
 * Used wherever a screen needs a single target variant — a bundle's parent
 * line, a merged line's representative variant, and anything later that points
 * at one variant.
 */
export function VariantSelectCard({
  title,
  description,
  selectedLabel = null,
  onRemove,
  onPick,
  pickerAvailable = true,
  emptyText = 'No variant chosen.',
  chooseLabel = 'Choose variant',
  changeLabel = 'Change variant',
  unavailableText = 'Product picker is available inside the Shopify admin.',
}: VariantSelectCardProps) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">{title}</Text>
        {description && (
          <Text as="span" variant="bodySm" tone="subdued">{description}</Text>
        )}
        <InlineStack gap="200" blockAlign="center">
          {selectedLabel ? (
            <Tag onRemove={onRemove}>{selectedLabel}</Tag>
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">{emptyText}</Text>
          )}
          <Button onClick={onPick} disabled={!pickerAvailable}>
            {selectedLabel ? changeLabel : chooseLabel}
          </Button>
        </InlineStack>
        {!pickerAvailable && (
          <Text as="span" variant="bodySm" tone="subdued">{unavailableText}</Text>
        )}
      </BlockStack>
    </Card>
  );
}
