// web/templates/hooks.ts
//
// react-query hooks binding the template gallery + create flow to the
// Worker. Each builds an App Bridge 4 authenticated fetcher (Bearer id-token)
// so requireShop accepts the request. Mirrors web/bundles/hooks.ts.
import { useAppBridge } from '@shopify/app-bridge-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAuthenticatedFetch } from '../api';
import {
  createDiscountFromTemplate, fetchTemplate, fetchTemplates,
  type CreateDiscountInput,
} from './api';

export function useTemplates() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({ queryKey: ['templates'], queryFn: () => fetchTemplates(fetcher) });
}

export function useTemplate(slug: string | undefined) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['template', slug],
    queryFn: () => fetchTemplate(fetcher, slug as string),
    enabled: Boolean(slug),
  });
}

export function useCreateDiscount() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDiscountInput) => createDiscountFromTemplate(fetcher, input),
    // The `discounts/create` webhook mirrors the new row; invalidating makes
    // the list refetch rather than showing a stale page.
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['discounts'] }); },
  });
}
