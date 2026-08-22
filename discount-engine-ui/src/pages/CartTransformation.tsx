import { useNavigate } from 'react-router-dom';
import { Badge, BlockStack, Button, Card, IndexTable, InlineStack, Page, Text } from '@shopify/polaris';
import { useBundleCampaigns, useCartTransforms } from '../store/useDiscountStore';
import type { CartTransformOp } from '../types';
import { SymbolTile } from '../components/common/SymbolTile';
import { getOp } from '../components/discount/cartTransformOps';

const OP_TONE: Record<CartTransformOp, 'info' | 'magic' | 'warning'> = {
  merge: 'info',
  expand: 'magic',
  update: 'warning',
};

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const itemSummary = (items: string[]) =>
  items.slice(0, 2).join(' · ') + (items.length > 2 ? ` · +${items.length - 2}` : '');

export default function CartTransformation() {
  const bundles = useCartTransforms();
  const campaigns = useBundleCampaigns();
  const navigate = useNavigate();

  const campaignCount = (bundleId: string) =>
    campaigns.filter((c) => c.bundles.some((b) => b.bundleId === bundleId)).length;

  return (
    <Page
      title="Bundles"
      subtitle="Define a bundle once — the variants it merges or expands, and its base price. Schedule it and set campaign prices in a bundle campaign."
      primaryAction={{ content: 'Create bundle', onAction: () => navigate('/bundles/new') }}
    >
      <Card padding="0">
        <IndexTable
          resourceName={{ singular: 'bundle', plural: 'bundles' }}
          itemCount={bundles.length}
          selectable={false}
          headings={[
            { title: 'Bundle' },
            { title: 'Operation' },
            { title: 'Price', alignment: 'end' },
            { title: 'Save', alignment: 'end' },
            { title: 'In campaigns', alignment: 'end' },
            { title: 'Updated' },
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
                        {itemSummary(b.items)}
                      </Text>
                    </BlockStack>
                  </InlineStack>
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
                  {used > 0 ? (
                    <Text as="span" numeric alignment="end">
                      {used}
                    </Text>
                  ) : (
                    <Text as="span" numeric alignment="end" tone="subdued">
                      —
                    </Text>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" tone="subdued">
                    {b.updated}
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
    </Page>
  );
}
