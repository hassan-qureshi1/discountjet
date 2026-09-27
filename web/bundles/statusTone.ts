import type { Tone } from '../types/discounts';
import type { BundleStatus } from '../types/bundles';

/**
 * Badge tone per bundle status. Matches the mapping the E7 campaign spec uses,
 * so a merchant reads the same colours across bundles and campaigns.
 */
export const STATUS_TONE: Record<BundleStatus, Tone> = {
  Active: 'success',
  Scheduled: 'info',
  Ended: 'neutral',
  Draft: 'warning',
};
