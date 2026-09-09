import { useNavigate } from 'react-router-dom';
import {
  Badge, Banner, BlockStack, Box, Button, Card, IndexTable, InlineGrid, InlineStack, Page, Spinner, Text,
} from '@shopify/polaris';
import { useBundlesQuery } from '../bundles/hooks';
import { getOp } from '../bundles/ops';
import type { Bundle, BundleOperation } from '../types/bundles';
import { SymbolTile } from '../components/SymbolTile';

const OP_TONE: Record<BundleOperation, 'info' | 'magic' | 'warning'> = {
  merge: 'info',
  expand: 'magic',
  update: 'warning',
};

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A small row of generic package tiles standing in for a bundle's items (no product names available). */
function ItemThumbs({ count }: { count: number }) {
  const shown = Math.min(count, 4);
  const extra = count - shown;
  return (
    <InlineStack gap="100" blockAlign="center">
      {Array.from({ length: shown }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            flex: '0 0 auto',
            background: 'var(--p-color-bg-surface-secondary)',
            boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
          }}
        >
          📦
        </div>
      ))}
      {extra > 0 && (
        <Text as="span" variant="bodySm" tone="subdued">
          +
          {extra}
        </Text>
      )}
    </InlineStack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box padding="400">
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="headingLg" fontWeight="bold">
          {value}
        </Text>
      </BlockStack>
    </Box>
  );
}

export default function Bundles() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useBundlesQuery();

  const bundles = data?.bundles ?? [];
  const summary = data?.summary ?? { count: 0, inCampaigns: 0, avgSaving: 0 };

  return (
    <Page
      title="Bundles"
      subtitle="Define a bundle once — the variants it merges or expands, and its base price. Schedule it and set campaign prices in a bundle campaign."
      primaryAction={{ content: 'Create bundle', onAction: () => navigate('/bundles/new') }}
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical">{error.message}</Banner>}

        <Card padding="0">
          <InlineGrid columns={{ xs: 1, sm: 3 }}>
            <Stat label="Bundles" value={String(summary.count)} />
            <Box borderInlineStartWidth="025" borderColor="border">
              <Stat label="In campaigns" value={String(summary.inCampaigns)} />
            </Box>
            <Box borderInlineStartWidth="025" borderColor="border">
              <Stat label="Avg. saving" value={money(summary.avgSaving)} />
            </Box>
          </InlineGrid>
        </Card>

        <Card padding="0">
          {isLoading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
              <Spinner accessibilityLabel="Loading bundles" size="small" />
            </div>
          ) : (
            <IndexTable
              resourceName={{ singular: 'bundle', plural: 'bundles' }}
              itemCount={bundles.length}
              selectable={false}
              headings={[
                { title: 'Bundle' },
                { title: 'Items' },
                { title: 'Operation' },
                { title: 'Price', alignment: 'end' },
                { title: 'Save', alignment: 'end' },
                { title: 'In campaigns', alignment: 'end' },
                { title: '' },
              ]}
            >
              {bundles.map((b: Bundle, index: number) => {
                const save = b.price != null && b.sumOfItems != null ? b.sumOfItems - b.price : null;
                return (
                  <IndexTable.Row id={b.id} key={b.id} position={index}>
                    <IndexTable.Cell>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <SymbolTile symbol="⇄" size={30} />
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {b.name}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {b.items.length}
                            {' '}
                            variants ·
                            {b.updated}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <ItemThumbs count={b.items.length} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={OP_TONE[b.operation]}>{getOp(b.operation).label}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" numeric alignment="end" fontWeight="semibold">
                        {b.price != null ? money(b.price) : '—'}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <div style={{ textAlign: 'right' }}>
                        {save != null && save > 0 ? (
                          <Badge tone="success">{`−${money(save)}`}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">—</Text>
                        )}
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" numeric alignment="end" tone="subdued">
                        —
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button variant="plain" onClick={() => navigate(`/bundles/${b.id}/edit`)}>
                        Edit
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
