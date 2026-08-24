import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Page,
  Tabs,
  Text,
} from '@shopify/polaris';
import { useDiscounts } from '../store/useDiscountStore';
import { DISCOUNT_TYPE_LABEL, type Discount } from '../types';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';
import { DiscountTypeModal } from '../components/common/DiscountTypeModal';

type FilterId = 'all' | 'tier' | 'bundle' | 'special' | 'inactive';

const MATCHERS: Record<FilterId, (d: Discount) => boolean> = {
  all: () => true,
  tier: (d) => d.type === 'Tier',
  bundle: (d) => d.type === 'Bundle',
  special: (d) => d.type === 'Special',
  inactive: (d) => d.status === 'Inactive',
};

export default function Discounts() {
  const discounts = useDiscounts();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const filters: { id: FilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'tier', label: 'Volume' },
    { id: 'bundle', label: 'Buy X, get Y' },
    { id: 'special', label: 'Buy X, discount both' },
    { id: 'inactive', label: 'Inactive' },
  ];

  const tabs = filters.map((f) => ({
    id: f.id,
    content: f.label,
    badge: String(discounts.filter(MATCHERS[f.id]).length),
  }));

  const rows = discounts.filter(MATCHERS[filters[selected].id]);

  return (
    <Page
      title="Discounts"
      subtitle="Synced from Shopify via webhooks. Open a discount to see its details and design its storefront upsell."
      titleMetadata={<Badge tone="success">Synced from Shopify</Badge>}
      primaryAction={{ content: 'Create discount', onAction: () => setModalOpen(true) }}
    >
      <BlockStack gap="300">
        <Card padding="0">
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected}>
            <IndexTable
              resourceName={{ singular: 'discount', plural: 'discounts' }}
              itemCount={rows.length}
              selectable={false}
              headings={[
                { title: 'Discount' },
                { title: 'Type' },
                { title: 'Status' },
                { title: 'Products', alignment: 'end' },
                { title: 'Updated' },
                { title: '' },
              ]}
            >
              {rows.map((d, index) => (
                <IndexTable.Row id={d.id} key={d.id} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <SymbolTile symbol={d.symbol} size={30} />
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {d.name}
                      </Text>
                      {d.campaignId && <Badge tone="info">Campaign</Badge>}
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone="magic">{DISCOUNT_TYPE_LABEL[d.type]}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <StatusBadge
                      tone={d.status === 'Active' ? 'success' : 'neutral'}
                      label={d.status}
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end">
                      {d.products}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">
                      {d.updated}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button variant="plain" onClick={() => navigate(`/discounts/${d.id}`)}>
                      View
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Tabs>
        </Card>
      </BlockStack>

      <DiscountTypeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelectEngine={(kind) => {
          setModalOpen(false);
          navigate(`/discounts/new?type=${kind}`);
        }}
      />
    </Page>
  );
}
