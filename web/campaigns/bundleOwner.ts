// web/campaigns/bundleOwner.ts
//
// Which campaigns hold a bundle, for the Bundles step's informational badge.
// Pure, and out of the component, so the rule can be asserted directly.
import type { Campaign } from './api';
import { formatWindowLabel } from '../lib/schedule';
import { isCampaignLocking } from '../../src/lib/campaignStatus';

/**
 * The campaigns that hold `bundleId`, other than the one being edited.
 *
 * Read off the CAMPAIGN LIST — which campaigns list this bundle — and never
 * off `bundle.campaignId`. That column is a cache of who owns the bundle RIGHT
 * NOW, re-derived by the schedule pass each time it runs, so a campaign
 * scheduled for a future window does not appear in it at all. Driving the
 * badge from it therefore hid the one conflict a merchant can actually
 * provoke: publishing a window that overlaps a campaign queued for later, the
 * exact case the server answers with a 409. The merchant met that refusal with
 * nothing on screen to explain it.
 *
 * `isCampaignLocking` rather than a hand-written status list, so this cannot
 * disagree with the server or with the bundle editor about which statuses own
 * a bundle. An `Ended` campaign that once held the bundle is not a holder: its
 * window has passed and it blocks nothing.
 *
 * Ordered by start date so a queue reads in the order it will run, with a
 * campaign that is already running (no start recorded, or the earliest one)
 * first.
 */
export function holdersOfBundle(
  campaigns: Campaign[],
  bundleId: string,
  excludeCampaignId: string,
): Campaign[] {
  return campaigns
    .filter((c) => c.id !== excludeCampaignId
      && isCampaignLocking(c.status)
      && c.bundleIds.includes(bundleId))
    .slice()
    .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
}

/**
 * The badge text for one holder: who, and WHEN.
 *
 * The window is part of the label rather than a tooltip because it is the
 * whole decision the merchant is making — "already in another campaign" is not
 * actionable, "already in another campaign that runs 1–31 Dec" tells them
 * which dates to avoid.
 */
export function describeHolder(campaign: Campaign): string {
  const window = campaign.startsAt === null
    ? 'no start date'
    : [
      formatWindowLabel(campaign.startsAt),
      campaign.endsAt === null ? 'onwards' : `– ${formatWindowLabel(campaign.endsAt)}`,
    ].join(' ');
  return `In "${campaign.name}" (${campaign.status}): ${window}`;
}
