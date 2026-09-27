import {
  BlockStack, Badge, Button, Card, InlineStack, Text,
} from '@shopify/polaris';
import { SymbolTile } from './SymbolTile';

export interface TemplateCardProps {
  symbol?: string | null;
  name: string;
  description: string;
  example?: string | null;
  category: string;
  actionLabel?: string;
  onAction: () => void;
}

/** A pickable preset: tile, name, description, an example, and one action. */
export function TemplateCard({
  symbol, name, description, example, category, actionLabel = 'Use template', onAction,
}: TemplateCardProps) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <SymbolTile symbol={symbol ?? '%'} size={30} />
          <Text as="h3" variant="headingSm">{name}</Text>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">{description}</Text>
        {example && <Badge>{example}</Badge>}
        <InlineStack align="space-between" blockAlign="center">
          <Badge tone="info">{category}</Badge>
          <Button variant="primary" onClick={onAction}>{actionLabel}</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
