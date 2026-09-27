import type { Tone } from '../types/discounts';
import type { CampaignStatus } from './api';

/**
 * Badge tone per campaign status. Matches the vocabulary `web/bundles/statusTone.ts`
 * uses, so a merchant reads the same colours across bundles and campaigns.
 */
export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone> = {
  Draft: 'warning',
  Scheduled: 'info',
  Published: 'success',
  Ended: 'neutral',
};
