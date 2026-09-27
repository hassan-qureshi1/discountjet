// web/campaigns/steps/BundlesStep.tsx
//
// Step 2 of the campaign builder. A multi-select over every bundle in the
// shop. Selecting/deselecting writes straight through `useUpdateCampaign` —
// same "view over the Draft, not a buffer" rule as DiscountsStep.
//
// Two things a row can be locked by, and both must say why rather than just
// vanishing:
//   1. Owned by another still-live (Scheduled/Published) campaign — that
//      campaign's `bundle.campaignId` claim, set at ITS publish.
//   2. An `update`-operation bundle on a shop that isn't Shopify Plus
//      eligible — the same non-blocking gate `OperationPicker` uses.
import {
  Badge, Banner, BlockStack, Card, Checkbox, InlineStack, Spinner, Text,
} from '@shopify/polaris';
import type { Campaign } from '../api';
import { useCampaigns, useUpdateCampaign } from '../hooks';
import { useBundlesQuery, useShopPlanQuery } from '../../bundles/hooks';
import { gateOperation, OP_TONE } from '../../bundles/ops';
import { CAMPAIGN_STATUS_TONE } from '../statusTone';
import { StatusBadge } from '../../components/StatusBadge';

export function BundlesStep({ campaign }: { campaign: Campaign }) {
  const { data: bundlesData, isLoading: bundlesLoading, error: bundlesError } = useBundlesQuery();
  const { data: campaignsData } = useCampaigns();
  const { data: planData } = useShopPlanQuery();
  const updateMutation = useUpdateCampaign();

  const bundles = bundlesData?.bundles ?? [];
  const allCampaigns = campaignsData?.campaigns ?? [];
  const updateOpEligible = planData?.updateOpEligible ?? false;
  const selected = new Set(campaign.bundleIds);

  const toggle = async (bundleId: string) => {
    const next = new Set(selected);
    if (next.has(bundleId)) next.delete(bundleId);
    else next.add(bundleId);
    await updateMutation.mutateAsync({ id: campaign.id, input: { bundleIds: Array.from(next) } });
  };

  if (bundlesLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
        <Spinner accessibilityLabel="Loading bundles" size="small" />
      </div>
    );
  }

  if (bundlesError) {
    return <Banner tone="critical">{bundlesError.message}</Banner>;
  }

  return (
    <BlockStack gap="400">
      {updateMutation.error && <Banner tone="critical">{updateMutation.error.message}</Banner>}

      {bundles.length === 0 ? (
        <Card>
          <Text as="p" tone="subdued">No bundles exist yet. Create one from the Bundles page, then come back here.</Text>
        </Card>
      ) : (
        <Card>
          <BlockStack gap="300">
            {bundles.map((bundle) => {
              // Owned by another campaign's `bundle.campaignId` claim, set only
              // at THAT campaign's publish — never at attach — so a bundle
              // merely listed in another Draft's bundleIds is still free here.
              const owner = bundle.campaignId && bundle.campaignId !== campaign.id
                ? allCampaigns.find((c) => c.id === bundle.campaignId)
                : undefined;
              const ownerLocks = Boolean(owner) && (owner!.status === 'Scheduled' || owner!.status === 'Published');

              const planGate = gateOperation(bundle.operation, updateOpEligible, planData?.planName);
              const disabled = ownerLocks || !planGate.enabled || updateMutation.isPending;

              return (
                <InlineStack key={bundle.id} align="space-between" blockAlign="center">
                  <Checkbox
                    label={bundle.name}
                    checked={selected.has(bundle.id)}
                    disabled={disabled}
                    onChange={() => toggle(bundle.id)}
                  />
                  <InlineStack gap="150" blockAlign="center">
                    <Badge tone={OP_TONE[bundle.operation]}>{bundle.operation}</Badge>
                    {ownerLocks && owner && (
                      <StatusBadge
                        label={`Owned by "${owner.name}" (${owner.status})`}
                        tone={CAMPAIGN_STATUS_TONE[owner.status]}
                      />
                    )}
                    {!ownerLocks && !planGate.enabled && (
                      <Badge tone="warning">{planGate.reason}</Badge>
                    )}
                  </InlineStack>
                </InlineStack>
              );
            })}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
