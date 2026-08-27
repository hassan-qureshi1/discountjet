import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Banner, BlockStack, Button, ButtonGroup, Card, IndexTable, InlineStack, Page, Tabs, Text } from '@shopify/polaris';
import { useDiscounts, useShopifyDiscounts } from '../store/useDiscountStore';
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
  const appDiscounts = useDiscounts();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  // Resolve the app discount a native row links to, to know if it's campaign-owned.
  const appOf = (row: ShopifyDiscount) => (row.appId ? appDiscounts.find((d) => d.id === row.appId) : undefined);

  const filters: { id: FilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'expired', label: 'Expired' },
  ];

  const tabs = filters.map((f) => ({ id: f.id, content: f.label }));
  const rows = discounts.filter(MATCHERS[filters[selected].id]);
  const anyCampaignOwned = discounts.some((d) => appOf(d)?.campaignId);

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
        {anyCampaignOwned && (
          <Banner tone="info" title="Some discounts are managed by a campaign">
            <p>Campaign-owned discounts are read-only here — open one to see which campaign it belongs to.</p>
          </Banner>
        )}

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
                { title: '' },
              ]}
            >
              {rows.map((d, index) => {
                const app = appOf(d);
                return (
                  <IndexTable.Row id={d.id} key={d.id} position={index}>
                    <IndexTable.Cell>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {d.title}
                        </Text>
                        {app?.campaignId && <Badge tone="info">Campaign</Badge>}
                      </InlineStack>
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
                    <IndexTable.Cell>
                      {d.appId ? (
                        <ButtonGroup>
                          <Button variant="plain" onClick={() => navigate(`/discounts/${d.appId}`)}>
                            View
                          </Button>
                          {!app?.campaignId && (
                            <Button variant="plain" onClick={() => navigate(`/discounts/${d.appId}/edit`)}>
                              Edit
                            </Button>
                          )}
                        </ButtonGroup>
                      ) : (
                        <Button variant="plain" disabled>
                          View in Shopify
                        </Button>
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
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
