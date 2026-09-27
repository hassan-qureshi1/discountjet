import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Banner, BlockStack, EmptyState, IndexTable, InlineStack, Page, Spinner, Tabs, Text,
} from '@shopify/polaris';
import { useCampaigns } from '../campaigns/hooks';
import type { Campaign, CampaignStatus } from '../campaigns/api';
import { StatusBadge } from '../components/StatusBadge';
import { CAMPAIGN_STATUS_TONE } from '../campaigns/statusTone';
import { formatWindowLabel } from '../lib/schedule';

// Polaris' own empty-state illustration.
const EMPTY_STATE_ILLUSTRATION = 'https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png';

type StatusTab = 'All' | CampaignStatus;

const TABS: StatusTab[] = ['All', 'Draft', 'Scheduled', 'Published', 'Ended'];

function windowLabel(campaign: Campaign): string {
  if (!campaign.startsAt && !campaign.endsAt) return 'Immediate';
  const start = campaign.startsAt ? formatWindowLabel(campaign.startsAt) : null;
  const end = campaign.endsAt ? formatWindowLabel(campaign.endsAt) : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `From ${start}`;
  if (end) return `Until ${end}`;
  return 'Immediate';
}

export default function Campaigns() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useCampaigns();
  const [tab, setTab] = useState<StatusTab>('All');

  const campaigns = data?.campaigns ?? [];
  // Filtering is client-side over the already-derived `status` — the server
  // is the source of truth for what that status is; this only narrows the view.
  const visible = tab === 'All' ? campaigns : campaigns.filter((c) => c.status === tab);

  const tabs = useMemo(
    () => TABS.map((label) => ({ id: label, content: label })),
    [],
  );
  const selectedIndex = TABS.indexOf(tab);

  const handleRowClick = (campaign: Campaign) => {
    navigate(campaign.status === 'Draft' ? `/campaigns/${campaign.id}/edit` : `/campaigns/${campaign.id}`);
  };

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
        <Spinner accessibilityLabel="Loading campaigns" size="small" />
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState heading="No campaigns yet" image={EMPTY_STATE_ILLUSTRATION}>
        <p>
          Create a campaign to group discounts and bundles onto one schedule window and publish them together.
        </p>
      </EmptyState>
    );
  } else {
    body = (
      <IndexTable
        resourceName={{ singular: 'campaign', plural: 'campaigns' }}
        itemCount={visible.length}
        selectable={false}
        headings={[
          { title: 'Campaign' },
          { title: 'Status' },
          { title: 'Discounts', alignment: 'end' },
          { title: 'Bundles', alignment: 'end' },
          { title: 'Window' },
        ]}
      >
        {visible.map((campaign, index) => (
          <IndexTable.Row
            id={campaign.id}
            key={campaign.id}
            position={index}
            onClick={() => handleRowClick(campaign)}
          >
            <IndexTable.Cell>
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {campaign.name}
                </Text>
                {campaign.description && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {campaign.description}
                  </Text>
                )}
              </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <StatusBadge label={campaign.status} tone={CAMPAIGN_STATUS_TONE[campaign.status]} />
            </IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack align="end">
                <Text as="span" numeric alignment="end">
                  {campaign.discounts.length}
                </Text>
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack align="end">
                <Text as="span" numeric alignment="end">
                  {campaign.bundleIds.length}
                </Text>
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" variant="bodySm" tone="subdued">
                {windowLabel(campaign)}
              </Text>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    );
  }

  return (
    <Page
      title="Campaigns"
      subtitle="Group discounts and bundles onto one schedule window and publish them together."
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical">{error.message}</Banner>}

        <Tabs
          tabs={tabs}
          selected={selectedIndex === -1 ? 0 : selectedIndex}
          onSelect={(index) => setTab(TABS[index])}
        />

        {body}
      </BlockStack>
    </Page>
  );
}
