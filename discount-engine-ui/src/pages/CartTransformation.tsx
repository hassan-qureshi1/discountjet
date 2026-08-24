import { useNavigate } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useBundleCampaigns, useCartTransforms } from '../store/useDiscountStore';
import type { CartTransformOp } from '../types';
import { SymbolTile } from '../components/common/SymbolTile';
import { getOp } from '../components/discount/cartTransformOps';
import { emojiForTitle } from '../components/discount/discountForm';

const OP_TONE: Record<CartTransformOp, 'info' | 'magic' | 'warning'> = {
  merge: 'info',
  expand: 'magic',
  update: 'warning',
};

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/** A small row of product image tiles for a bundle's items. */
function ItemThumbs({ items }: { items: string[] }) {
  const shown = items.slice(0, 4);
  const extra = items.length - shown.length;
  return (
    <InlineStack gap="100" blockAlign="center">
      {shown.map((name, i) => (
        <div
          key={i}
          title={name}
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
          {emojiForTitle(name)}
        </div>
      ))}
      {extra > 0 && (
        <Text as="span" variant="bodySm" tone="subdued">
          +{extra}
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

export default function CartTransformation() {
  const bundles = useCartTransforms();
  const campaigns = useBundleCampaigns();
  const navigate = useNavigate();

  const campaignCount = (bundleId: string) =>
    campaigns.filter((c) => c.bundles.some((b) => b.bundleId === bundleId)).length;

  const inCampaigns = bundles.filter((b) => campaignCount(b.id) > 0).length;
  const avgSaving = bundles.length
    ? Math.round(bundles.reduce((sum, b) => sum + (b.sumOfItems - b.price), 0) / bundles.length)
    : 0;

  return (
    <Page
      title="Bundles"
      subtitle="Define a bundle once — the variants it merges or expands, and its base price. Schedule it and set campaign prices in a bundle campaign."
      primaryAction={{ content: 'Create bundle', onAction: () => navigate('/bundles/new') }}
    >
      <BlockStack gap="400">
        <Card padding="0">
          <InlineGrid columns={{ xs: 1, sm: 3 }}>
            <Stat label="Bundles" value={String(bundles.length)} />
            <Box borderInlineStartWidth="025" borderColor="border">
              <Stat label="In campaigns" value={String(inCampaigns)} />
            </Box>
            <Box borderInlineStartWidth="025" borderColor="border">
              <Stat label="Avg. saving" value={money(avgSaving)} />
            </Box>
          </InlineGrid>
        </Card>

        <Card padding="0">
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
            {bundles.map((b, index) => {
              const used = campaignCount(b.id);
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
                          {b.items.length} variants · {b.updated}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <ItemThumbs items={b.items} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={OP_TONE[b.operation]}>{getOp(b.operation).label}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end" fontWeight="semibold">
                      {money(b.price)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div style={{ textAlign: 'right' }}>
                      <Badge tone="success">{`−${money(b.sumOfItems - b.price)}`}</Badge>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end" tone={used > 0 ? undefined : 'subdued'}>
                      {used > 0 ? String(used) : '—'}
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
        </Card>
      </BlockStack>
    </Page>
  );
}
