// web/campaigns/publishOutcome.ts
//
// The two judgements the campaign builder's Summary step makes, kept out of
// the component so they can be asserted on directly.
import type { CampaignDiscount, PublishCampaignResponse } from './api';
import { METAFIELD_MAX_SIZE_BYTES } from '../../src/lib/discountEngines/tier';

/**
 * The discounts whose config is too big to publish.
 *
 * The 10 KB cap is PER METAFIELD VALUE, and each discount owns one — the
 * column comment on `campaignDiscount.configBytes` says so, `createDiscount.ts`
 * enforces it per discount, and the builder's Discounts step measures it per
 * discount. Summing the campaign's discounts and comparing the total would
 * block three perfectly legal 4 KB discounts on a limit none of them comes
 * near.
 */
export function oversizedDiscounts(discounts: CampaignDiscount[]): CampaignDiscount[] {
  return discounts.filter((d) => d.configBytes > METAFIELD_MAX_SIZE_BYTES);
}

/** The combined size, for display only — it gates nothing. */
export function totalConfigBytes(discounts: CampaignDiscount[]): number {
  return discounts.reduce((sum, d) => sum + d.configBytes, 0);
}

export interface PublishOutcome {
  tone: 'critical' | 'warning';
  title: string;
  summary: string;
}

/**
 * What to tell the merchant after a publish that did not fully succeed.
 *
 * Driven by the RESPONSE'S `status` — the campaign's actual stored state —
 * never inferred from `created`. The route reverts to `Draft` only when
 * nothing at all went live, and "nothing went live" is not the same as
 * "`created === 0`": a bundles-only campaign can schedule bundles with zero
 * discounts created, and a campaign can be left Published with failures
 * beside it. Inferring from a count is how the banner came to promise a
 * safe retry on a campaign that PUT, DELETE and republish had all started
 * refusing.
 */
export function describePublishOutcome(result: PublishCampaignResponse): PublishOutcome {
  const counts = `${result.created} discount${result.created === 1 ? '' : 's'} created, ${result.failed} failed.`;

  if (result.status === 'Draft') {
    return {
      tone: 'critical',
      title: 'Nothing was published',
      summary: `${counts} The campaign stays a Draft — nothing went live, so it is safe to fix and try again.`,
    };
  }

  return {
    tone: 'warning',
    title: 'This campaign published partially',
    summary: `${counts} The campaign is now ${result.status} and can no longer be edited — clone it into a new Draft to fix what failed.`,
  };
}
