// web/discounts/hooks.ts
//
// react-query hooks binding the discount screens to the Worker. Each builds an
// App Bridge 4 authenticated fetcher (Bearer id-token) so requireShop accepts
// the request. Keys are stable so navigating back to a list is cache-instant.
import { useAppBridge } from '@shopify/app-bridge-react';
import { useQuery } from '@tanstack/react-query';
import { createAuthenticatedFetch } from '../api';
import { fetchDiscount, fetchDiscounts, fetchShopifyDiscounts } from './api';

export function useDiscountsQuery() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['discounts'],
    queryFn: () => fetchDiscounts(fetcher),
  });
}

export function useDiscountQuery(id: string | undefined) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['discount', id],
    queryFn: () => fetchDiscount(fetcher, id as string),
    enabled: Boolean(id),
  });
}

export function useShopifyDiscountsQuery() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['shopify-discounts'],
    queryFn: () => fetchShopifyDiscounts(fetcher),
  });
}
