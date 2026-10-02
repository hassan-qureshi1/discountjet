import { useQuery } from '@tanstack/react-query';
import { useAppBridge } from '@shopify/app-bridge-react';
import { apiFetch, createAuthenticatedFetch } from '../api';
import type { Tone } from '../types/discounts';

/** Mirrors `OverviewDto` in `src/routes/overview.ts`. */
export interface OverviewStat {
  label: string;
  value: string;
  detail: string | null;
  badges: Array<{ label: string; tone: Tone }>;
}

export interface ActivityItem {
  id: string;
  title: string;
  action: 'created' | 'updated' | 'deleted' | 'other';
  meta: string;
  at: string;
}

export interface ScheduleItem {
  id: string;
  name: string;
  operation: 'merge' | 'expand' | 'update';
  status: 'Draft' | 'Scheduled' | 'Active' | 'Ended';
  window: string | null;
  campaignId: string | null;
}

export interface Overview {
  shopName: string | null;
  stats: OverviewStat[];
  recentActivity: ActivityItem[];
  bundleSchedule: ScheduleItem[];
  generatedAt: string;
}

/**
 * The dashboard's one read.
 *
 * `staleTime` is zero on purpose: this page exists to say what is true right
 * now, and a cached figure is the one thing it must not show. The window-focus
 * refetch is what makes it correct after a merchant publishes a campaign in
 * another tab and comes back.
 */
export function useOverview() {
  const shopify = useAppBridge();
  return useQuery({
    queryKey: ['overview'],
    queryFn: () => apiFetch<Overview>(createAuthenticatedFetch(shopify), '/api/overview'),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
