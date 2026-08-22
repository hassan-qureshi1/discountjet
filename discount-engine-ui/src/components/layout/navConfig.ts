import {
  CalendarIcon,
  CartIcon,
  CollectionIcon,
  CreditCardIcon,
  DiscountIcon,
  HomeIcon,
} from '@shopify/polaris-icons';
import type { IconSource } from '@shopify/polaris';

/** Which store collection to count in the nav badge, if any. */
export type CountKey = 'campaigns' | 'discounts' | 'cartTransforms';

export interface NavRoute {
  path: string;
  label: string;
  icon: IconSource;
  countKey?: CountKey;
}

// Single source of truth for both the left Navigation and the Router routes.
export const NAV_ROUTES: NavRoute[] = [
  { path: '/', label: 'Overview', icon: HomeIcon },
  { path: '/templates', label: 'Templates', icon: CollectionIcon },
  { path: '/campaigns', label: 'Campaigns', icon: CalendarIcon, countKey: 'campaigns' },
  { path: '/discounts', label: 'Discounts', icon: DiscountIcon, countKey: 'discounts' },
  { path: '/bundles', label: 'Bundles', icon: CartIcon, countKey: 'cartTransforms' },
  { path: '/plan', label: 'Plan & limits', icon: CreditCardIcon },
];
