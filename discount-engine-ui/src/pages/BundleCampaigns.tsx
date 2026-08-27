import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Tabs,
  Text,
} from '@shopify/polaris';
import { useBundleCampaigns, useCartTransforms } from '../store/useDiscountStore';
import type { BundleCampaign, BundleCampaignStatus, Tone } from '../types';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';

const STATUS_TONE: Record<BundleCampaignStatus, Tone> = {
  Draft: 'warning',
  Scheduled: 'info',
  Active: 'success',
  Ended: 'neutral',
};

const dateOnly = (s: string) => s.split('  ')[0];

type FilterId = 'all' | 'draft' | 'scheduled' | 'active' | 'ended';
const MATCHERS: Record<FilterId, (c: BundleCampaign) => boolean> = {
  all: () => true,
  draft: (c) => c.status === 'Draft',
  scheduled: (c) => c.status === 'Scheduled',
  active: (c) => c.status === 'Active',
  ended: (c) => c.status === 'Ended',
};

export default function BundleCampaigns() {
  const campaigns = useBundleCampaigns();
  const bundles = useCartTransforms();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);

  const nameOf = (bundleId: string) => bundles.find((b) => b.id === bundleId)?.name ?? bundleId;
  const count = (id: FilterId) => campaigns.filter(MATCHERS[id]).length;
  const filters: { id: FilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Draft' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'active', label: 'Active' },
    { id: 'ended', label: 'Ended' },
  ];
  const tabs = filters.map((f) => ({ id: f.id, content: f.label, badge: String(count(f.id)) }));
  const rows = campaigns.filter(MATCHERS[filters[selected].id]);

  return (
    <Page
      title="Bundle campaigns"
      subtitle="Schedule your bundles over a date window and set each bundle’s price and compare-at price for the campaign."
      primaryAction={{ content: 'Create campaign', onAction: () => navigate('/bundle-campaigns/new') }}
    >
      <BlockStack gap="400">
        <Card padding="0">
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected}>
            <IndexTable
              resourceName={{ singular: 'campaign', plural: 'campaigns' }}
              itemCount={rows.length}
              selectable={false}
              emptyState={
                <EmptyState
                  heading="No bundle campaigns yet"
                  action={{ content: 'Create campaign', onAction: () => navigate('/bundle-campaigns/new') }}
                  image=""
                >
                  <p>Group a few bundles on one schedule and set their campaign prices.</p>
                </EmptyState>
              }
              headings={[
                { title: 'Campaign' },
                { title: 'Bundles', alignment: 'end' },
                { title: 'Schedule' },
                { title: 'Status' },
                { title: '' },
              ]}
            >
              {rows.map((c, index) => (
                <IndexTable.Row id={c.id} key={c.id} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <SymbolTile symbol="◈" size={30} />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {c.name}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {c.bundles.map((b) => nameOf(b.bundleId)).join(' · ')}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end">
                      {c.bundles.length}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">
                      {`${dateOnly(c.starts)} → ${dateOnly(c.ends)}`}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <StatusBadge tone={STATUS_TONE[c.status]} label={c.status} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button variant="plain" onClick={() => navigate(`/bundle-campaigns/${c.id}/edit`)}>
                      Edit
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Tabs>
        </Card>
      </BlockStack>
    </Page>
  );
}
