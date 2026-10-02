import { deriveStatus } from './scheduleWindow';

export type CampaignStatus = 'Draft' | 'Scheduled' | 'Published' | 'Ended';

/**
 * What a campaign's status is right now.
 *
 * `Draft` is the merchant's state and is never derived over — an unpublished
 * campaign has no window in force whatever dates it carries. Everything after
 * publish is a function of the window, so there is nothing to write and nothing
 * to go stale.
 *
 * Reuses `deriveStatus`, reading its `Active` as `Published` to match the
 * prototype's vocabulary. Same concept, and deliberately the same code — a
 * campaign and its bundles must agree about what a window means, and the surest
 * way is for both to ask the same function.
 */
export function deriveCampaignStatus(
  stored: CampaignStatus,
  startsAt: string | null,
  endsAt: string | null,
  now: string,
): CampaignStatus {
  if (stored === 'Draft') return 'Draft';
  const derived = deriveStatus(startsAt, endsAt, now);
  return derived === 'Active' ? 'Published' : derived;
}

/**
 * Whether a campaign in this status owns its members.
 *
 * Derived rather than stored, because nothing runs when a window closes: an
 * ended campaign's bundles and discounts free themselves the moment the window
 * passes, with no sweep to write and nothing to be left behind.
 */
export function isCampaignLocking(status: CampaignStatus): boolean {
  return status === 'Scheduled' || status === 'Published';
}
