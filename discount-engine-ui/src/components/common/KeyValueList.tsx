import { InlineGrid, Text } from '@shopify/polaris';
import { Fragment, type ReactNode } from 'react';

/** A compact definition list (term → value) rendered as a two-column grid. */
export function KeyValueList({ items }: { items: { term: string; description: ReactNode }[] }) {
  return (
    <InlineGrid columns="auto 1fr" gap="200">
      {items.map((item) => (
        <Fragment key={item.term}>
          <Text as="span" variant="bodySm" tone="subdued">
            {item.term}
          </Text>
          <Text as="span" variant="bodySm">
            {item.description}
          </Text>
        </Fragment>
      ))}
    </InlineGrid>
  );
}
