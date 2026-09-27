// web/Pages/CampaignDetail.tsx
//
// Read-only detail screen for a published (Scheduled/Published/Ended)
// campaign, reached from the Campaigns list for anything past Draft. A
// published campaign is immutable — the server 409s any PUT/DELETE that
// isn't a Draft — so this page offers no edit affordances at all. The only
// way forward is "Clone to edit", which creates a fresh Draft and lands the
// merchant in the builder for it.
//
// `status` is always what the server returns (`Campaign.status`), never
// recomputed here — the server derives it from the window, and this page
// only displays that derivation.
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Banner, BlockStack, Card, InlineStack, Link, List, Page, Spinner, Text,
} from '@shopify/polaris';
import { useCampaign, useCloneCampaign } from '../campaigns/hooks';
import type { CampaignDiscountPublishState } from '../campaigns/api';
import { useBundlesQuery } from '../bundles/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { CAMPAIGN_STATUS_TONE } from '../campaigns/statusTone';
import { STATUS_TONE as BUNDLE_STATUS_TONE } from '../bundles/statusTone';
import { formatWindowLabel } from '../lib/schedule';
import type { Tone } from '../types/discounts';

const PUBLISH_STATE_TONE: Record<CampaignDiscountPublishState, Tone> = {
  pending: 'info',
  created: 'success',
  failed: 'critical',
};

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useCampaign(id);
  const campaign = data?.campaign;
  const isNotFound = error ? /failed: 404\b/.test(error.message) : false;

  const cloneMutation = useCloneCampaign();
  const [cloneError, setCloneError] = useState<string | null>(null);

  // Bundle names for `campaign.bundleIds` — the campaign DTO carries only
  // ids, so this cross-references the shop's full bundle list. Loading and
  // error states are handled independently of the campaign fetch below, per
  // web/CLAUDE.md ("every async UI shows a spinner/Banner, not just the
  // first request").
  const { data: bundlesData, isLoading: bundlesLoading, error: bundlesError } = useBundlesQuery();

  if (isLoading) {
    return (
      <Page title="Campaign" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spinner accessibilityLabel="Loading campaign" />
        </div>
      </Page>
    );
  }

  if (error && !isNotFound) {
    return (
      <Page title="Campaign" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <Banner tone="critical">{error.message}</Banner>
      </Page>
    );
  }

  if (!campaign) {
    return (
      <Page title="Campaign not found" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <Card><Text as="p">This campaign doesn&apos;t exist. It may have been deleted.</Text></Card>
      </Page>
    );
  }

  const windowLabel = campaign.scheduleMode === 'immediate'
    ? 'Immediately on publish'
    : [
      campaign.startsAt ? `From ${formatWindowLabel(campaign.startsAt)}` : null,
      campaign.endsAt ? `until ${formatWindowLabel(campaign.endsAt)}` : null,
    ].filter(Boolean).join(' ') || 'No bound set';

  const failedDiscounts = campaign.discounts.filter((d) => d.publishState === 'failed');

  const bundles = bundlesData?.bundles ?? [];

  const handleClone = async () => {
    setCloneError(null);
    try {
      const result = await cloneMutation.mutateAsync(campaign.id);
      navigate(`/campaigns/${result.campaignId}/edit`);
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : 'Failed to clone this campaign.');
    }
  };

  return (
    <Page
      title={campaign.name}
      backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}
      primaryAction={{
        content: 'Clone to edit',
        onAction: handleClone,
        loading: cloneMutation.isPending,
      }}
    >
      <BlockStack gap="400">
        {cloneError && <Banner tone="critical" onDismiss={() => setCloneError(null)}>{cloneError}</Banner>}

        <Banner tone="info" title="This campaign is read-only">
          <p>
            Published campaigns can&apos;t be edited directly — changes to a live campaign could
            desynchronise its discounts and bundles from the window they were published onto. Use
            &quot;Clone to edit&quot; to open a new Draft with the same discounts and bundles, make
            your changes there, and publish it separately.
          </p>
        </Banner>

        {/* A failed discount is one the merchant believes is live and isn't —
            this must be impossible to miss, so it gets its own critical Banner
            above the fold rather than only showing up as a badge in the list
            below. */}
        {failedDiscounts.length > 0 && (
          <Banner tone="critical" title="Some discounts failed to publish">
            <List type="bullet">
              {failedDiscounts.map((d) => (
                <List.Item key={d.id}>{`${d.name}: ${d.publishError ?? 'Unknown error'}`}</List.Item>
              ))}
            </List>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingSm">Status</Text>
              <StatusBadge label={campaign.status} tone={CAMPAIGN_STATUS_TONE[campaign.status]} />
            </InlineStack>
            {campaign.description && (
              <Text as="p" tone="subdued">{campaign.description}</Text>
            )}
            <InlineStack align="space-between">
              <Text as="span">Window</Text>
              <Text as="span">{windowLabel}</Text>
            </InlineStack>
            {campaign.publishedAt && (
              <InlineStack align="space-between">
                <Text as="span">Published</Text>
                <Text as="span">{formatWindowLabel(campaign.publishedAt)}</Text>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingSm">{`Discounts (${campaign.discounts.length})`}</Text>
            {campaign.discounts.length === 0 ? (
              <Text as="p" tone="subdued">No discounts.</Text>
            ) : (
              <BlockStack gap="300">
                {campaign.discounts.map((d) => (
                  <InlineStack key={d.id} align="space-between" blockAlign="start" wrap={false}>
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">{d.name}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`${d.type} · ${d.method === 'code' ? `Code: ${d.code}` : 'Automatic'}`}
                      </Text>
                      {d.shopifyGid && (
                        <Text as="span" variant="bodySm" tone="subdued">{d.shopifyGid}</Text>
                      )}
                    </BlockStack>
                    <StatusBadge label={d.publishState} tone={PUBLISH_STATE_TONE[d.publishState]} />
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingSm">{`Bundles (${campaign.bundleIds.length})`}</Text>
            {bundlesLoading ? (
              <div style={{ display: 'grid', placeItems: 'center', padding: 20 }}>
                <Spinner accessibilityLabel="Loading bundles" size="small" />
              </div>
            ) : null}
            {bundlesError && <Banner tone="critical">{bundlesError.message}</Banner>}
            {!bundlesLoading && !bundlesError && (
              campaign.bundleIds.length === 0 ? (
                <Text as="p" tone="subdued">No bundles.</Text>
              ) : (
                <BlockStack gap="200">
                  {campaign.bundleIds.map((bundleId) => {
                    const bundle = bundles.find((b) => b.id === bundleId);
                    return (
                      <InlineStack key={bundleId} align="space-between" blockAlign="center">
                        <Link url={`/bundles/${bundleId}/edit`}>
                          {bundle?.name ?? bundleId}
                        </Link>
                        {bundle && <StatusBadge label={bundle.status} tone={BUNDLE_STATUS_TONE[bundle.status]} />}
                      </InlineStack>
                    );
                  })}
                </BlockStack>
              )
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
