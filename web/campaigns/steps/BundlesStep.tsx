// web/campaigns/steps/BundlesStep.tsx
//
// Step 2 of the campaign builder. A multi-select over every bundle in the
// shop. Selecting/deselecting writes straight through `useUpdateCampaign` —
// same "view over the Draft, not a buffer" rule as DiscountsStep.
//
// A row can be disabled by an `update`-operation bundle on a shop that isn't
// Shopify Plus eligible — the same non-blocking gate `OperationPicker` uses —
// and must say why rather than just vanishing.
//
// Ownership is NOT a block. A bundle held by another still-live
// (Scheduled/Published) campaign can still be ticked, because a Draft only
// lists the bundle and writes nothing to it. The row names the holders and
// their windows as information; the server refuses a genuine OVERLAP at
// publish, where the window is written.
//
// Which campaigns hold a bundle is read from the CAMPAIGN LIST, never from
// `bundle.campaignId` — see `holdersOfBundle`. That column now names whoever
// owns the bundle right now, re-derived by the schedule pass, so a campaign
// queued for a future window is absent from it; a badge driven by it showed
// nothing for exactly the case the merchant can provoke, then met them with a
// 409 they had been given no warning of.
//
// Three requests feed this screen (`useBundlesQuery`, `useCampaigns`,
// `useShopPlanQuery`), and all three need a spinner on load and a Banner on
// error per `web/CLAUDE.md` — not just the first one. `useCampaigns` in
// particular is the ONLY source of a bundle's holders: if it fails, defaulting
// its list to empty (as if failure meant "no other campaigns exist") would show
// a held bundle as unheld, which is false. Ownership no longer blocks
// selection, but the merchant should not tick rows while the UI cannot say who
// else holds them, so a `useCampaigns` error disables every row instead of
// silently treating everything as unheld.
import { useState } from 'react';
import {
  Badge, Banner, BlockStack, Card, Checkbox, InlineStack, Spinner, Text, TextField,
} from '@shopify/polaris';
import type { Campaign } from '../api';
import { useCampaigns, useUpdateCampaign } from '../hooks';
import { useBundlesQuery, useShopPlanQuery, useUpdateBundle } from '../../bundles/hooks';
import type { Bundle, BundleInput } from '../../bundles/api';
import { currencySymbol } from '../../lib/money';
import { gateOperation, OP_TONE } from '../../bundles/ops';
import { describeHolder, holdersOfBundle } from '../bundleOwner';
import { StatusBadge } from '../../components/StatusBadge';

/**
 * The two prices a campaign applies to one of its bundles, editable in place.
 *
 * These edit the BUNDLE, not this campaign's copy of it — there is no
 * per-campaign price column, by design: the spec defines the sale price as the
 * bundle's own price. So a change here follows the bundle everywhere it
 * appears. The section heading says so, because a field on a campaign screen
 * otherwise reads as campaign-scoped.
 *
 * Saved on blur rather than per keystroke: each save is a PUT that re-resolves
 * the bundle's variants through the Admin API, so saving mid-number would be
 * both wasteful and visibly laggy.
 */
function BundlePriceFields({
  bundle,
  disabled,
  moneyPrefix,
  onSaved,
}: {
  bundle: Bundle;
  disabled: boolean;
  moneyPrefix: string | undefined;
  onSaved: (message: string | null) => void;
}) {
  const updateBundle = useUpdateBundle();
  const [priceStr, setPriceStr] = useState(bundle.price?.amount ?? '');
  const [compareAtStr, setCompareAtStr] = useState(bundle.compareAtPrice?.amount ?? '');

  const save = async (input: Partial<BundleInput>) => {
    onSaved(null);
    try {
      await updateBundle.mutateAsync({ id: bundle.id, input });
    } catch (err) {
      onSaved(err instanceof Error ? err.message : 'Could not save the price.');
    }
  };

  const savePrice = () => {
    const trimmed = priceStr.trim();
    const parsed = parseFloat(trimmed);
    // A blank price is not zero — it means "leave the product at its own
    // price", which is what `null` says to the schedule pass.
    if (trimmed !== '' && !Number.isFinite(parsed)) return;
    if ((bundle.price?.amount ?? '') === trimmed) return;
    save({ price: trimmed === '' ? undefined : parsed });
  };

  const saveCompareAt = () => {
    const trimmed = compareAtStr.trim();
    const parsed = parseFloat(trimmed);
    if (trimmed !== '' && !Number.isFinite(parsed)) return;
    if ((bundle.compareAtPrice?.amount ?? '') === trimmed) return;
    // Empty means null, never 0: null is "use the sum of the components", a
    // stored 0 would publish a 0.00 strikethrough.
    save({ compareAtPrice: trimmed === '' ? null : parsed });
  };

  return (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
      <div style={{ width: 150 }}>
        <TextField
          label="Sale price"
          labelHidden
          placeholder="Sale price"
          type="number"
          inputMode="decimal"
          prefix={moneyPrefix}
          value={priceStr}
          onChange={setPriceStr}
          onBlur={savePrice}
          disabled={disabled || updateBundle.isPending}
          autoComplete="off"
        />
      </div>
      <div style={{ width: 150 }}>
        <TextField
          label="Compare-at price"
          labelHidden
          // The component sum is the PLACEHOLDER, never a prefill: a prefilled
          // number would be saved as an explicit value and go stale the moment
          // the components change, where null always means today's sum.
          placeholder={bundle.sumOfItems?.amount ?? 'Compare-at'}
          type="number"
          inputMode="decimal"
          prefix={moneyPrefix}
          value={compareAtStr}
          onChange={setCompareAtStr}
          onBlur={saveCompareAt}
          disabled={disabled || updateBundle.isPending}
          autoComplete="off"
        />
      </div>
    </InlineStack>
  );
}

export function BundlesStep({ campaign }: { campaign: Campaign }) {
  const { data: bundlesData, isLoading: bundlesLoading, error: bundlesError } = useBundlesQuery();
  const { data: campaignsData, isLoading: campaignsLoading, error: campaignsError } = useCampaigns();
  const { data: planData, isLoading: planLoading, error: planError } = useShopPlanQuery();
  const updateMutation = useUpdateCampaign();

  const bundles = bundlesData?.bundles ?? [];
  const allCampaigns = campaignsData?.campaigns ?? [];
  const updateOpEligible = planData?.updateOpEligible ?? false;
  // What the merchant has clicked but the server has not confirmed yet. The
  // checked state used to come straight off `campaign.bundleIds`, so a click
  // showed nothing until the PUT *and* the follow-up refetch had both landed,
  // while `isPending` disabled every row in the meantime — a second of a dead,
  // unchanged control that reads as "the checkbox does nothing", and swallows
  // any further click. The optimistic set is shown immediately and dropped
  // once the server's own answer arrives or the write fails.
  const [optimistic, setOptimistic] = useState<Set<string> | null>(null);
  // A failed price save on one row; shown once above the list rather than
  // per row, so a narrow row is not asked to carry a Banner.
  const [priceError, setPriceError] = useState<string | null>(null);
  const moneyPrefix = currencySymbol(planData?.currencyCode);
  const selected = optimistic ?? new Set(campaign.bundleIds);

  // A failed `useCampaigns` means "we cannot name a bundle's holders right
  // now" — never "there are no other campaigns". Every row is disabled until
  // it recovers, rather than rendering a held bundle as unheld.
  const canVerifyLocks = !campaignsError;

  const toggle = async (bundleId: string) => {
    const next = new Set(selected);
    if (next.has(bundleId)) next.delete(bundleId);
    else next.add(bundleId);
    setOptimistic(next);
    try {
      await updateMutation.mutateAsync({ id: campaign.id, input: { bundleIds: Array.from(next) } });
      // Server state is authoritative again from here: dropping the optimistic
      // set lets the refetched campaign take over, so a write the server
      // altered (or rejected a member of) is never masked by what we guessed.
      setOptimistic(null);
    } catch {
      // Put the checkbox back where the server still has it, rather than
      // leaving a tick the server never accepted. The reason is already shown
      // by the `updateMutation.error` banner above, so it is not repeated here.
      setOptimistic(null);
    }
  };

  if (bundlesLoading || campaignsLoading || planLoading) {
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
      {priceError && <Banner tone="critical">{priceError}</Banner>}
      {/* Said plainly because a price field on a campaign screen otherwise
          reads as campaign-scoped: there is no per-campaign price, so this
          edits the bundle itself and follows it everywhere. */}
      <Text as="p" variant="bodySm" tone="subdued">
        Prices here edit the bundle itself, so a change applies everywhere that bundle is used.
        The campaign puts the sale price live for its window and restores the original at the end.
      </Text>
      {campaignsError && (
        <Banner tone="critical">
          {`Couldn't load your campaigns, so bundle owners can't be shown and selection is disabled until this loads: ${campaignsError.message}`}
        </Banner>
      )}
      {planError && (
        <Banner tone="warning">
          {`Couldn't load this shop's plan, so Shopify Plus gating below may be inaccurate: ${planError.message}`}
        </Banner>
      )}

      {bundles.length === 0 ? (
        <Card>
          <Text as="p" tone="subdued">No bundles exist yet. Create one from the Bundles page, then come back here.</Text>
        </Card>
      ) : (
        <Card>
          <BlockStack gap="300">
            {bundles.map((bundle) => {
              // Every still-live campaign that LISTS this bundle, published or
              // merely scheduled — not just whichever one happens to own it at
              // this instant. A queue is shown as a queue, in the order it
              // runs, because any one of these windows is a window this
              // campaign's dates must avoid.
              const holders = holdersOfBundle(allCampaigns, bundle.id, campaign.id);

              const planGate = gateOperation(bundle.operation, updateOpEligible, planData?.planName);
              // `isPending` deliberately absent: a write in flight used to disable
              // every row, so a merchant selecting several bundles in a row had
              // all but the first click swallowed. Each toggle sends the whole
              // set, so a later write simply supersedes an earlier one.
              // `holders` is absent on purpose: ticking a row only lists the
              // bundle in this Draft and writes nothing to it, so another
              // campaign holding it is information, not a block. The server
              // refuses an overlap at publish, where the window is written.
              const disabled = !canVerifyLocks || !planGate.enabled;

              return (
                <InlineStack key={bundle.id} align="space-between" blockAlign="center" gap="300">
                  <Checkbox
                    label={bundle.name}
                    checked={selected.has(bundle.id)}
                    disabled={disabled}
                    onChange={() => toggle(bundle.id)}
                  />
                  <InlineStack gap="150" blockAlign="center" wrap={false}>
                    {/* Pricing is only meaningful for the operation the sale
                        actually applies to. A merge bundle's adjustment is
                        based on its components' sum rather than the parent's
                        price, so offering these fields there would invite an
                        edit that changes nothing a shopper sees. */}
                    {bundle.operation === 'expand' && (
                      <BundlePriceFields
                        bundle={bundle}
                        disabled={disabled}
                        moneyPrefix={moneyPrefix}
                        onSaved={setPriceError}
                      />
                    )}
                    <Badge tone={OP_TONE[bundle.operation]}>{bundle.operation}</Badge>
                    {holders.map((holder) => (
                      <StatusBadge
                        key={holder.id}
                        label={describeHolder(holder)}
                        tone="info"
                      />
                    ))}
                    {!planGate.enabled && (
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
