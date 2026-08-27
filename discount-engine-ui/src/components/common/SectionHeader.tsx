import { InlineStack, Text } from '@shopify/polaris';
import type { ReactNode } from 'react';

/**
 * Card header row — a title on the left and an optional action on the right.
 * Polaris v13 Card has no built-in title slot, so we compose it.
 */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <InlineStack align="space-between" blockAlign="center" wrap={false}>
      <Text as="h3" variant="headingSm">
        {title}
      </Text>
      {action}
    </InlineStack>
  );
}
