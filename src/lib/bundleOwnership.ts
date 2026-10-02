import { deriveCampaignStatus, isCampaignLocking, type CampaignStatus } from './campaignStatus';
import type { ICampaignRepository } from '../db/repositories/CampaignRepository';

/** The campaign that currently owns a bundle's schedule, when one does. */
export interface LockingOwner {
  id: string;
  name: string;
  status: CampaignStatus;
}

/**
 * Resolves the still-locking campaign behind a bundle's `campaignId`, or null.
 *
 * ONE place answers "is this bundle's schedule owned right now?", because two
 * places answering it is exactly how the campaign routes and the bundle PUT
 * would come to disagree — and a disagreement here means the campaign's
 * discounts and its bundles running on different windows, silently. The
 * predicate itself stays `isCampaignLocking`; this only supplies it the
 * DERIVED status, so an owner whose window has closed frees its bundles with
 * nothing to sweep.
 *
 * `excludeCampaignId` is the campaign asking. A bundle a campaign already owns
 * is not locked against that same campaign.
 */
export async function findLockingCampaign(
  campaigns: ICampaignRepository,
  bundleCampaignId: string | null,
  excludeCampaignId: string | null,
  now: string,
): Promise<LockingOwner | null> {
  if (!bundleCampaignId) return null;
  if (excludeCampaignId !== null && bundleCampaignId === excludeCampaignId) return null;

  const owner = await campaigns.findById(bundleCampaignId);
  // Dangling reference — nothing left to lock against.
  if (!owner) return null;

  const status = deriveCampaignStatus(owner.status, owner.startsAt, owner.endsAt, now);
  if (!isCampaignLocking(status)) return null;

  return { id: owner.id, name: owner.name, status };
}
