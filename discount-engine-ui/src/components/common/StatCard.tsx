import { BlockStack, Card, InlineStack, Text } from '@shopify/polaris';
import type { OverviewStat } from '../../types';
import { StatusBadge } from './StatusBadge';

export function StatCard({ stat }: { stat: OverviewStat }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="span" variant="bodySm" tone="subdued">
          {stat.label}
        </Text>
        <Text
          as="p"
          variant={stat.positive ? 'headingLg' : 'heading2xl'}
          fontWeight="bold"
          tone={stat.positive ? 'success' : undefined}
        >
          {stat.value}
        </Text>
        {stat.detail && (
          <Text as="span" variant="bodySm" tone="subdued">
            {stat.detail}
          </Text>
        )}
        {stat.badges && stat.badges.length > 0 && (
          <InlineStack gap="150">
            {stat.badges.map((b, i) => (
              <StatusBadge key={i} tone={b.tone} label={b.label} />
            ))}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}
