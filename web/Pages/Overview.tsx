// web/Pages/Overview.tsx
//
// The dashboard: a read-only aggregation of what other screens own. Every
// figure here comes from one GET, computed on demand — there is no rollup
// table and no cache, because a page whose whole job is to say what is true
// now is the worst place for a stale number.
//
// Option A of the approved mockups: KPI cards across the top, then recent
// activity beside the bundle schedule.
import { useNavigate } from 'react-router-dom';
import {
  Badge, Banner, BlockStack, Card, EmptyState, InlineGrid, InlineStack, Page, Spinner, Text,
} from '@shopify/polaris';
import { useOverview } from '../overview/api';
import type { ActivityItem, OverviewStat, ScheduleItem } from '../overview/api';
import { StatusBadge } from '../components/StatusBadge';
import { STATUS_TONE } from '../bundles/statusTone';

const EMPTY_STATE_ILLUSTRATION = 'https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png';

const ACTION_LABEL: Record<ActivityItem['action'], string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  other: 'changed',
};

function StatCard({ stat }: { stat: OverviewStat }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">{stat.label}</Text>
        <Text as="p" variant="heading2xl" numeric>{stat.value}</Text>
        {stat.detail && (
          <Text as="p" variant="bodySm" tone="subdued">{stat.detail}</Text>
        )}
        {stat.badges.length > 0 && (
          <InlineStack gap="150">
            {stat.badges.map((badge) => (
              <StatusBadge key={badge.label} label={badge.label} tone={badge.tone} />
            ))}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <InlineStack align="space-between" blockAlign="start" wrap={false} gap="300">
      <BlockStack gap="050">
        <Text as="span" variant="bodyMd" fontWeight="semibold" breakWord>
          {item.title}
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          {`${item.meta} · ${ACTION_LABEL[item.action]}`}
        </Text>
      </BlockStack>
      <Text as="span" variant="bodySm" tone="subdued">
        {new Date(item.at).toLocaleString()}
      </Text>
    </InlineStack>
  );
}

function ScheduleRow({ item, onOpen }: { item: ScheduleItem; onOpen: () => void }) {
  return (
    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
      <BlockStack gap="050">
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          <a
            href={`/bundles/${item.id}/edit`}
            onClick={(e) => { e.preventDefault(); onOpen(); }}
            style={{ color: 'inherit' }}
          >
            {item.name}
          </a>
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          {item.window ? `${item.operation} · ${item.window}` : `${item.operation} · no window set`}
        </Text>
      </BlockStack>
      <InlineStack gap="150" blockAlign="center">
        {item.campaignId && <Badge tone="info">In a campaign</Badge>}
        <StatusBadge label={item.status} tone={STATUS_TONE[item.status]} />
      </InlineStack>
    </InlineStack>
  );
}

export default function Overview() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useOverview();

  if (isLoading) {
    return (
      <Page title="Overview">
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spinner accessibilityLabel="Loading overview" />
        </div>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Overview">
        <Banner tone="critical">{error.message}</Banner>
      </Page>
    );
  }

  if (!data) return null;

  return (
    <Page
      title="Overview"
      subtitle={data.shopName ?? undefined}
      primaryAction={{ content: 'Create discount', onAction: () => navigate('/templates') }}
      secondaryActions={[{ content: 'View campaigns', onAction: () => navigate('/campaigns') }]}
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
          {data.stats.map((stat) => <StatCard key={stat.label} stat={stat} />)}
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">Recent discount activity</Text>
              {data.recentActivity.length === 0 ? (
                <EmptyState image={EMPTY_STATE_ILLUSTRATION}>
                  <Text as="p" tone="subdued">
                    No discount webhooks yet. Changes made in Shopify will show up here.
                  </Text>
                </EmptyState>
              ) : (
                <BlockStack gap="300">
                  {data.recentActivity.map((item) => <ActivityRow key={item.id} item={item} />)}
                </BlockStack>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">Bundle schedule</Text>
              {data.bundleSchedule.length === 0 ? (
                <EmptyState image={EMPTY_STATE_ILLUSTRATION}>
                  <Text as="p" tone="subdued">No bundles yet.</Text>
                </EmptyState>
              ) : (
                <BlockStack gap="300">
                  {data.bundleSchedule.map((item) => (
                    <ScheduleRow
                      key={item.id}
                      item={item}
                      onOpen={() => navigate(`/bundles/${item.id}/edit`)}
                    />
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
