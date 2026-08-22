import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Divider,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useCampaign } from '../store/useDiscountStore';
import type { CampaignStatus, Tone } from '../types';
import { KeyValueList } from '../components/common/KeyValueList';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';

const STATUS_TONE: Record<CampaignStatus, Tone> = {
  Draft: 'warning',
  Scheduled: 'info',
  Published: 'success',
  Ended: 'neutral',
};

const money = (n: number | null) => (n === null ? '—' : `$${n.toLocaleString('en-US')}`);

const DISCOUNTS = [
  { name: 'Buy 2 Pillows, save 15%', type: 'Tier', gid: 'gid://…/1042' },
  { name: 'Mattress + Base bundle', type: 'Bundle', gid: 'gid://…/1043' },
  { name: 'Sheet set BOGO', type: 'Special', gid: 'gid://…/1044' },
];

function Metric({ label, value, sub, live }: { label: string; value: string; sub: string; live?: boolean }) {
  return (
    <Box padding="400">
      <BlockStack gap="100">
        <InlineStack gap="150" blockAlign="center">
          {live && <Badge tone="success">Live</Badge>}
          <Text as="span" variant="bodySm" tone="subdued">
            {label}
          </Text>
        </InlineStack>
        <Text as="span" variant="headingLg" fontWeight="bold">
          {value}
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          {sub}
        </Text>
      </BlockStack>
    </Box>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const campaign = useCampaign(id);
  const navigate = useNavigate();

  if (!campaign) {
    return (
      <Page title="Campaign not found" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <Card>
          <Text as="p">This campaign doesn’t exist.</Text>
        </Card>
      </Page>
    );
  }

  const aov =
    campaign.revenue !== null && campaign.orders
      ? `$${(campaign.revenue / campaign.orders).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
  const discPct =
    campaign.revenue && campaign.discount
      ? `${((campaign.discount / campaign.revenue) * 100).toFixed(1)}% of revenue`
      : 'across this campaign';

  return (
    <Page
      backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}
      title={campaign.name}
      titleMetadata={<StatusBadge tone={STATUS_TONE[campaign.status]} label={campaign.status} />}
      subtitle="Discounts are live in Shopify · read-only"
      primaryAction={{ content: 'Clone to edit', onAction: () => navigate('/campaigns/new') }}
      secondaryActions={[{ content: 'View in Shopify' }]}
    >
      <BlockStack gap="400">
        <Banner tone="warning" title="This campaign is locked">
          <p>
            Its discounts already exist in Shopify. Editing them here would drift from what shoppers see, so changes are
            made by cloning into a new draft and publishing that.
          </p>
        </Banner>

        <Card padding="0">
          <InlineGrid columns={{ xs: 2, sm: 3, md: 5 }}>
            <Metric label="Revenue generated" value={money(campaign.revenue)} sub={discPct} live={campaign.live} />
            <Metric label="Orders handled" value={campaign.orders?.toLocaleString('en-US') ?? '—'} sub="with a campaign discount" />
            <Metric label="Discount allocated" value={money(campaign.discount)} sub="total allocated" />
            <Metric label="Avg. order value" value={aov} sub="per discounted order" />
            <Metric label="Redemptions" value={campaign.orders?.toLocaleString('en-US') ?? '—'} sub={`across ${campaign.discounts} discounts`} />
          </InlineGrid>
        </Card>

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          <BlockStack gap="400">
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Discounts in this campaign
                  </Text>
                  <Badge tone="magic">Created via GraphQL</Badge>
                </InlineStack>
              </Box>
              <IndexTable
                resourceName={{ singular: 'discount', plural: 'discounts' }}
                itemCount={DISCOUNTS.length}
                selectable={false}
                headings={[{ title: 'Discount' }, { title: 'Type' }, { title: 'Status' }, { title: 'Node ID' }]}
              >
                {DISCOUNTS.map((d, index) => (
                  <IndexTable.Row id={d.gid} key={d.gid} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {d.name}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone="info">{d.type}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone="success">Active</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <code>{d.gid}</code>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Cart-transform bundles
                  </Text>
                  <Badge tone="success">Metafield written</Badge>
                </InlineStack>
                <Divider />
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <SymbolTile symbol="⇄" size={28} />
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      Bed frame + 2 pillows
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      $899.00 · save $158
                    </Text>
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <SymbolTile symbol="⇄" size={28} />
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      Mattress + protector + sheets
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Assembled at checkout
                    </Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>

          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Schedule
                </Text>
                <Divider />
                <KeyValueList
                  items={[
                    { term: 'Status', description: <StatusBadge tone={STATUS_TONE[campaign.status]} label={campaign.status} /> },
                    { term: 'Window', description: campaign.schedule },
                    { term: 'Activated', description: 'Aug 1, 00:03 AEST' },
                    { term: 'Timezone', description: 'AEST' },
                  ]}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Publish log
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="start" wrap={false}>
                    <SymbolTile symbol="✓" size={24} />
                    <Text as="span" variant="bodySm">
                      <b>3 discounts created</b> via GraphQL · discountAutomaticAppCreate
                    </Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start" wrap={false}>
                    <SymbolTile symbol="✓" size={24} />
                    <Text as="span" variant="bodySm">
                      <b>Bundle metafield written</b> · $app:cart_transform
                    </Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start" wrap={false}>
                    <SymbolTile symbol="◷" size={24} />
                    <Text as="span" variant="bodySm">
                      <b>Auto-deactivate scheduled</b> · Sep 30 23:59
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
