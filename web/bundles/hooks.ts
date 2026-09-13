// web/bundles/hooks.ts
//
// react-query hooks binding the bundle screens to the Worker. Each builds an
// App Bridge 4 authenticated fetcher (Bearer id-token) so requireShop accepts
// the request. Keys are stable so navigating back to a list is cache-instant.
// Mirrors web/discounts/hooks.ts.
import { useAppBridge } from '@shopify/app-bridge-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAuthenticatedFetch } from '../api';
import {
  createBundle,
  deleteBundle,
  fetchActivation,
  fetchBundle,
  fetchBundles,
  fetchShopPlan,
  fetchVariants,
  updateBundle,
  type BundleInput,
} from './api';

export function useBundlesQuery() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['bundles'],
    queryFn: () => fetchBundles(fetcher),
  });
}

export function useBundleQuery(id: string | undefined) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['bundle', id],
    queryFn: () => fetchBundle(fetcher, id as string),
    enabled: Boolean(id),
  });
}

export function useShopPlanQuery() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['shop-plan'],
    queryFn: () => fetchShopPlan(fetcher),
  });
}

/**
 * Fires once on mount to trigger the Worker's `ensureCartTransform` side
 * effect (registers/adopts the store's cart-transform slot for already-
 * installed stores that never went through app install). `staleTime` keeps
 * it from re-firing on every remount within the window; `retry: false`
 * avoids hammering a genuinely broken (e.g. undeployed function) endpoint.
 */
export function useActivationQuery() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['bundle-activation'],
    queryFn: () => fetchActivation(fetcher),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * Resolves product/variant names + admin links for the variants currently on
 * screen. The key is the SORTED id list, so the query is shared between two
 * renders that hold the same variants in a different order, and refetches
 * only when the set itself changes (e.g. after the resource picker returns).
 */
export function useVariantsQuery(ids: string[]) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const sorted = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ['variants', sorted],
    queryFn: () => fetchVariants(fetcher, sorted),
    enabled: sorted.length > 0,
    // Catalogue names change rarely; this keeps re-entering the editor from
    // re-hitting the Admin API on every mount.
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateBundle() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BundleInput) => createBundle(fetcher, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bundles'] });
    },
  });
}

export function useUpdateBundle() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<BundleInput> }) => updateBundle(fetcher, id, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['bundles'] });
      queryClient.invalidateQueries({ queryKey: ['bundle', variables.id] });
    },
  });
}

export function useDeleteBundle() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteBundle(fetcher, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['bundles'] });
      queryClient.invalidateQueries({ queryKey: ['bundle', id] });
    },
  });
}
