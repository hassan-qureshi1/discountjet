// web/campaigns/steps/SummaryStep.tsx
//
// Step 4 of the campaign builder: what will be created, the combined config
// size against the 10KB cap, the window in local time, and a one-way Banner
// before Publish.
//
// Publishing can PARTIALLY succeed — some discounts created, others failed,
// and bundles skipped because another live campaign already owns them. A
// silent partial failure is the worst outcome here: the merchant would
// believe a promotion is live when it isn't. So a partial result keeps the
// merchant on this page with every failure named, rather than treating any
// non-zero `created` as an unqualified success.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, Banner, BlockStack, Button, Card, InlineStack, List, Text,
} from '@shopify/polaris';
import type { Campaign } from '../api';
import { usePublishCampaign } from '../hooks';
import { formatWindowLabel } from '../../lib/schedule';
import { METAFIELD_MAX_SIZE_BYTES } from '../../../src/lib/discountEngines/tier';

export function SummaryStep({ campaign }: { campaign: Campaign }) {
  const navigate = useNavigate();
  const publishMutation = usePublishCampaign();
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ created: number; failed: number; bundleFailures: { bundleId: string; error: string }[] } | null>(null);

  const totalConfigBytes = campaign.discounts.reduce((sum, d) => sum + d.configBytes, 0);
  const overCap = totalConfigBytes > METAFIELD_MAX_SIZE_BYTES;

  const windowLabel = campaign.scheduleMode === 'immediate'
    ? 'Immediately on publish'
    : [
      campaign.startsAt ? `From ${formatWindowLabel(campaign.startsAt)}` : null,
      campaign.endsAt ? `until ${formatWindowLabel(campaign.endsAt)}` : null,
    ].filter(Boolean).join(' ') || 'No bound set';

  const canPublish = (campaign.discounts.length > 0 || campaign.bundleIds.length > 0) && !overCap;

  const handlePublish = async () => {
    setBannerError(null);
    setPartial(null);
    try {
      const result = await publishMutation.mutateAsync(campaign.id);
      if (result.failed === 0 && result.bundleFailures.length === 0) {
        navigate(`/campaigns/${campaign.id}`);
        return;
      }
      // Partial (or total) failure: stay put and name every failure. The
      // per-discount reason lives on `campaign.discounts[].publishError` once
      // the invalidated campaign query refetches; `bundleFailures` already
      // carries its own merchant-readable message.
      setPartial({ created: result.created, failed: result.failed, bundleFailures: result.bundleFailures });
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to publish this campaign.');
    }
  };

  const failedDiscounts = campaign.discounts.filter((d) => d.publishState === 'failed');

  return (
    <BlockStack gap="400">
      {bannerError && <Banner tone="critical" onDismiss={() => setBannerError(null)}>{bannerError}</Banner>}

      {partial && (
        <Banner
          tone={partial.created === 0 ? 'critical' : 'warning'}
          title={partial.created === 0 ? 'Nothing was published' : 'This campaign published partially'}
        >
          <BlockStack gap="200">
            <Text as="p">
              {`${partial.created} discount${partial.created === 1 ? '' : 's'} created, ${partial.failed} failed.`}
              {partial.created === 0 && ' The campaign stays a Draft — nothing went live, so it is safe to fix and try again.'}
            </Text>
            {failedDiscounts.length > 0 && (
              <List type="bullet">
                {failedDiscounts.map((d) => (
                  <List.Item key={d.id}>{`${d.name}: ${d.publishError ?? 'Unknown error'}`}</List.Item>
                ))}
              </List>
            )}
            {partial.bundleFailures.length > 0 && (
              <>
                <Text as="p" fontWeight="semibold">Bundles skipped:</Text>
                <List type="bullet">
                  {partial.bundleFailures.map((f) => (
                    <List.Item key={f.bundleId}>{f.error}</List.Item>
                  ))}
                </List>
              </>
            )}
          </BlockStack>
        </Banner>
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingSm">What will be created</Text>
          <InlineStack align="space-between">
            <Text as="span">Discounts</Text>
            <Text as="span" numeric>{campaign.discounts.length}</Text>
          </InlineStack>
          <InlineStack align="space-between">
            <Text as="span">Bundles</Text>
            <Text as="span" numeric>{campaign.bundleIds.length}</Text>
          </InlineStack>
          <InlineStack align="space-between">
            <Text as="span">Combined discount config size</Text>
            <InlineStack gap="150" blockAlign="center">
              <Text as="span" numeric tone={overCap ? 'critical' : undefined}>
                {`${(totalConfigBytes / 1024).toFixed(1)}KB of ${(METAFIELD_MAX_SIZE_BYTES / 1024).toFixed(0)}KB`}
              </Text>
              {overCap && <Badge tone="critical">Over the limit</Badge>}
            </InlineStack>
          </InlineStack>
          <InlineStack align="space-between">
            <Text as="span">Window</Text>
            <Text as="span">{windowLabel}</Text>
          </InlineStack>
        </BlockStack>
      </Card>

      {!canPublish && !overCap && (
        <Banner tone="warning">Add at least one discount or bundle before publishing.</Banner>
      )}

      <Banner tone="warning" title="Publishing cannot be undone">
        <p>
          Once published, this campaign&apos;s discounts go live in Shopify and its bundles are
          scheduled onto this window. To make changes afterwards, clone the campaign into a new
          Draft.
        </p>
      </Banner>

      <InlineStack>
        <Button
          variant="primary"
          onClick={handlePublish}
          loading={publishMutation.isPending}
          disabled={!canPublish || publishMutation.isPending}
        >
          Publish campaign
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
