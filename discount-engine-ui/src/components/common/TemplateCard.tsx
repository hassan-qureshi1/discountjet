import { Badge, BlockStack, Box, Button, Card, InlineStack, Text } from '@shopify/polaris';
import type { Template } from '../../types';

export function TemplateCard({ template, onUse }: { template: Template; onUse: () => void }) {
  return (
    <Card>
      <BlockStack gap="300">
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            fontSize: 22,
            background: 'var(--p-color-bg-surface-brand)',
            boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
          }}
        >
          {template.emoji}
        </div>

        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">
            {template.name}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {template.description}
          </Text>
        </BlockStack>

        <Box background="bg-surface-secondary" padding="200" borderRadius="200">
          <Text as="span" variant="bodySm">
            {template.example}
          </Text>
        </Box>

        <InlineStack align="space-between" blockAlign="center">
          <Badge>{template.category}</Badge>
          <Button variant="primary" onClick={onUse}>
            Use template
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
