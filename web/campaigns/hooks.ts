// web/campaigns/hooks.ts
//
// react-query hooks binding the campaigns screens to the Worker. Each builds
// an App Bridge 4 authenticated fetcher (Bearer id-token) so requireShop
// accepts the request. Mirrors web/templates/hooks.ts and web/bundles/hooks.ts.
import { useAppBridge } from '@shopify/app-bridge-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAuthenticatedFetch } from '../api';
import {
  cloneCampaign,
  createCampaign,
  deleteCampaign,
  fetchCampaign,
  fetchCampaigns,
  publishCampaign,
  updateCampaign,
  type CampaignInput,
  type CampaignStatus,
} from './api';

export function useCampaigns(status?: CampaignStatus) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['campaigns', status],
    queryFn: () => fetchCampaigns(fetcher, status),
  });
}

export function useCampaign(id: string | undefined) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['campaign', id],
    queryFn: () => fetchCampaign(fetcher, id as string),
    enabled: Boolean(id),
  });
}

export function useCreateCampaign() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CampaignInput) => createCampaign(fetcher, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useUpdateCampaign() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<CampaignInput> }) => updateCampaign(fetcher, id, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign', variables.id] });
    },
  });
}

export function useDeleteCampaign() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCampaign(fetcher, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    },
  });
}

export function usePublishCampaign() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => publishCampaign(fetcher, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      // Publishing creates discounts (and schedules bundles) — the discounts
      // list must refetch to show them.
      queryClient.invalidateQueries({ queryKey: ['discounts'] });
      // Publish also rewrites every member bundle's scheduleStart/scheduleEnd,
      // status and campaignId. That last one is the input to the editor's and
      // the builder's schedule locks, so a stale bundles cache shows a
      // just-claimed bundle as free to edit.
      queryClient.invalidateQueries({ queryKey: ['bundles'] });
    },
  });
}

export function useCloneCampaign() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cloneCampaign(fetcher, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}
