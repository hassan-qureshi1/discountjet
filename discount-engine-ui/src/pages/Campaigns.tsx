import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  IndexTable,
  InlineStack,
  Page,
  Tabs,
  Text,
} from '@shopify/polaris';
import { ImportIcon } from '@shopify/polaris-icons';
import { useCampaigns } from '../store/useDiscountStore';
import type { Campaign, CampaignStatus, Tone } from '../types';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';

type FilterId = 'all' | 'draft' | 'scheduled' | 'published' | 'ended';

const STATUS_TONE: Record<CampaignStatus, Tone> = {
  Draft: 'warning',
  Scheduled: 'info',
  Published: 'success',
  Ended: 'neutral',
};

const money = (n: number | null) => (n === null ? '—' : `$${n.toLocaleString('en-US')}`);
const count = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));

export default function Campaigns() {
  const campaigns = useCampaigns();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);

  const filters: { id: FilterId; label: string; match: (c: Campaign) => boolean }[] = [
    { id: 'all', label: 'All', match: () => true },
    { id: 'draft', label: 'Draft', match: (c) => c.status === 'Draft' },
    { id: 'scheduled', label: 'Scheduled', match: (c) => c.status === 'Scheduled' },
    { id: 'published', label: 'Published', match: (c) => c.status === 'Published' },
    { id: 'ended', label: 'Ended', match: (c) => c.status === 'Ended' },
  ];

  const tabs = filters.map((f) => ({
    id: f.id,
    content: f.label,
    badge: String(campaigns.filter(f.match).length),
  }));

  const rows = campaigns.filter(filters[selected].match);

  return (
    <Page
      title="Campaigns"
      subtitle="A campaign groups discounts and bundles on one schedule. Publishing creates the discounts in Shopify via the GraphQL Admin API — once live, a campaign is locked, so clone it to make changes."
      primaryAction={{ content: 'Create campaign', onAction: () => navigate('/campaigns/new') }}
      secondaryActions={[
        { content: 'Browse templates', onAction: () => navigate('/campaigns/templates') },
        { content: 'Import CSV', icon: ImportIcon },
      ]}
    >
      <BlockStack gap="300">
        <Card padding="0">
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected}>
            <IndexTable
              resourceName={{ singular: 'campaign', plural: 'campaigns' }}
              itemCount={rows.length}
              selectable={false}
              headings={[
                { title: 'Campaign' },
                { title: 'Discounts', alignment: 'end' },
                { title: 'Bundles', alignment: 'end' },
                { title: 'Revenue', alignment: 'end' },
                { title: 'Orders', alignment: 'end' },
                { title: 'Discount', alignment: 'end' },
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
                          {c.detail}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end">
                      {c.discounts}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end">
                      {c.bundles}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end" tone={c.revenue === null ? 'subdued' : undefined}>
                      {money(c.revenue)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end" tone={c.orders === null ? 'subdued' : undefined}>
                      {count(c.orders)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end" tone={c.discount === null ? 'subdued' : undefined}>
                      {money(c.discount)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">
                      {c.schedule}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <StatusBadge tone={STATUS_TONE[c.status]} label={c.status} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <ButtonGroup>
                      {c.status === 'Draft' ? (
                        <Button variant="plain" onClick={() => navigate(`/campaigns/${c.id}/edit`)}>
                          Edit
                        </Button>
                      ) : (
                        <Button variant="plain" onClick={() => navigate(`/campaigns/${c.id}`)}>
                          View
                        </Button>
                      )}
                      <Button variant="plain" onClick={() => navigate('/campaigns/new')}>
                        Clone
                      </Button>
                    </ButtonGroup>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Tabs>
        </Card>

        <Text as="p" variant="bodySm" tone="subdued">
          Published &amp; scheduled campaigns are read-only. Use Clone to spin up an editable draft.
        </Text>
      </BlockStack>
    </Page>
  );
}
