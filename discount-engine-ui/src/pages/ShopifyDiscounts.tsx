import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, BlockStack, Card, IndexTable, Page, Tabs, Text } from '@shopify/polaris';
import { useShopifyDiscounts } from '../store/useDiscountStore';
import type { DiscountEngineKind, ShopifyDiscount } from '../types';
import { DiscountTypeModal } from '../components/common/DiscountTypeModal';

type FilterId = 'all' | 'active' | 'scheduled' | 'expired';

const MATCHERS: Record<FilterId, (d: ShopifyDiscount) => boolean> = {
  all: () => true,
  active: (d) => d.status === 'Active',
  scheduled: (d) => d.status === 'Scheduled',
  expired: (d) => d.status === 'Expired',
};

export default function ShopifyDiscounts() {
  const discounts = useShopifyDiscounts();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const filters: { id: FilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'expired', label: 'Expired' },
  ];

  const tabs = filters.map((f) => ({ id: f.id, content: f.label }));
  const rows = discounts.filter(MATCHERS[filters[selected].id]);

  const onSelectEngine = (kind: DiscountEngineKind) => {
    setModalOpen(false);
    navigate(`/discounts/new?type=${kind}`);
  };

  return (
    <Page
      title="Discounts"
      primaryAction={{ content: 'Create discount', onAction: () => setModalOpen(true) }}
      secondaryActions={[{ content: 'Export' }]}
    >
      <BlockStack gap="300">
        <Card padding="0">
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected}>
            <IndexTable
              resourceName={{ singular: 'discount', plural: 'discounts' }}
              itemCount={rows.length}
              selectable={false}
              headings={[
                { title: 'Title' },
                { title: 'Status' },
                { title: 'Method' },
                { title: 'Type' },
                { title: 'Used', alignment: 'end' },
              ]}
            >
              {rows.map((d, index) => (
                <IndexTable.Row id={d.id} key={d.id} position={index}>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {d.title}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={d.status === 'Active' ? 'success' : undefined}>{d.status}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">
                      {d.method}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {d.engine ? (
                      <Badge tone="magic">{d.type}</Badge>
                    ) : (
                      <Text as="span" tone="subdued">
                        {d.type}
                      </Text>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end">
                      {d.used}
                    </Text>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Tabs>
        </Card>

        <Text as="p" variant="bodySm" tone="subdued">
          Discounts created with Discount Engine appear here alongside native ones and sync into the app’s D1 tracker.
        </Text>
      </BlockStack>

      <DiscountTypeModal open={modalOpen} onClose={() => setModalOpen(false)} onSelectEngine={onSelectEngine} />
    </Page>
  );
}
