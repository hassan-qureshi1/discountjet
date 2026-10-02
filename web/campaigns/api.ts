// web/campaigns/api.ts
//
// Data layer for the campaigns list, wizard and detail screens. Thin wrappers
// over apiFetch that hit the Worker's campaign routes (src/routes/campaigns.ts).
// App Bridge auth is supplied by the caller (react-query hooks). Mirrors
// web/templates/api.ts.
import { apiFetch, type AuthenticatedFetch } from '../api';

export type CampaignStatus = 'Draft' | 'Scheduled' | 'Published' | 'Ended';

export type CampaignScheduleMode = 'immediate' | 'window';

export type CampaignDiscountMethod = 'automatic' | 'code';

export type CampaignDiscountPublishState = 'pending' | 'created' | 'failed';

export interface CampaignDiscount {
  id: string;
  name: string;
  type: 'tier' | 'bundle' | 'special';
  method: CampaignDiscountMethod;
  code: string | null;
  configJson: string;
  configBytes: number;
  shopifyGid: string | null;
  publishState: CampaignDiscountPublishState;
  publishError: string | null;
}

/** The campaign plus its discounts and bundle ids, as `GET /api/campaigns/:id` returns. */
export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  scheduleMode: CampaignScheduleMode;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  discounts: CampaignDiscount[];
  bundleIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Alias kept for readability at call sites that fetch a single campaign. */
export type CampaignDetail = Campaign;

/** What a client posts for one discount the campaign authors. */
export interface CampaignDiscountInput {
  type: 'tier' | 'bundle' | 'special';
  method: CampaignDiscountMethod;
  /** Required when `method` is 'code'. */
  code?: string;
  /** Required when `method` is 'automatic'; for `code` it defaults to `code`. */
  name?: string;
  /** The merchant's FORM state for the engine named by `type`. */
  configJson: unknown;
}

export interface CampaignInput {
  name?: string;
  description?: string | null;
  scheduleMode?: CampaignScheduleMode;
  startsAt?: string | null;
  endsAt?: string | null;
  discounts?: CampaignDiscountInput[];
  bundleIds?: string[];
}

export interface CampaignsResponse {
  campaigns: Campaign[];
}

export interface CampaignResponse {
  campaign: Campaign;
}

/** A bundle skipped at publish (e.g. already owned by another live campaign). */
export interface CampaignBundleFailure {
  bundleId: string;
  error: string;
}

export interface PublishCampaignResponse {
  status: CampaignStatus;
  created: number;
  failed: number;
  /** Bundles put on this campaign's window now, because its window is current. */
  bundlesStamped: number;
  /**
   * Bundles the schedule pass will take over later — either because the
   * campaign's window has not arrived, or because the bundle still holds the
   * previous campaign's pre-sale price and must hand it back first. Reported
   * apart from `bundlesStamped` so a publish that scheduled nothing today does
   * not read as one that scheduled everything.
   */
  bundlesQueued: number;
  bundleFailures: CampaignBundleFailure[];
}

export interface CloneCampaignResponse {
  campaignId: string;
}

export function fetchCampaigns(f: AuthenticatedFetch, status?: CampaignStatus): Promise<CampaignsResponse> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<CampaignsResponse>(f, `/api/campaigns${query}`);
}

export function fetchCampaign(f: AuthenticatedFetch, id: string): Promise<CampaignResponse> {
  return apiFetch<CampaignResponse>(f, `/api/campaigns/${encodeURIComponent(id)}`);
}

export function createCampaign(f: AuthenticatedFetch, input: CampaignInput): Promise<CampaignResponse> {
  return apiFetch<CampaignResponse>(f, '/api/campaigns', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateCampaign(
  f: AuthenticatedFetch,
  id: string,
  input: Partial<CampaignInput>,
): Promise<CampaignResponse> {
  return apiFetch<CampaignResponse>(f, `/api/campaigns/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteCampaign(f: AuthenticatedFetch, id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(f, `/api/campaigns/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function publishCampaign(f: AuthenticatedFetch, id: string): Promise<PublishCampaignResponse> {
  return apiFetch<PublishCampaignResponse>(f, `/api/campaigns/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
  });
}

export function cloneCampaign(f: AuthenticatedFetch, id: string): Promise<CloneCampaignResponse> {
  return apiFetch<CloneCampaignResponse>(f, `/api/campaigns/${encodeURIComponent(id)}/clone`, {
    method: 'POST',
  });
}
