import { useCallback, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Frame, Navigation, TopBar } from '@shopify/polaris';
import { DiscountIcon, HomeIcon, OrderIcon, ProductIcon } from '@shopify/polaris-icons';
import { useDiscountStore, useShop } from '../../store/useDiscountStore';
import { NAV_ROUTES, type CountKey } from './navConfig';

// Compact green "%" mark used as the app logo in the top bar.
const LOGO_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23008060'/%3E%3Cpath d='M11 21L21 11' stroke='white' stroke-width='2.2' stroke-linecap='round'/%3E%3Ccircle cx='12' cy='12' r='2' fill='white'/%3E%3Ccircle cx='20' cy='20' r='2' fill='white'/%3E%3C/svg%3E";

export function AppFrame({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const shop = useShop();
  const counts = useDiscountStore((s) => ({
    campaigns: s.campaigns.length,
    discounts: s.discounts.length,
    cartTransforms: s.cartTransforms.length,
    bundleCampaigns: s.bundleCampaigns.length,
  }));

  const [mobileNavActive, setMobileNavActive] = useState(false);
  const [userMenuActive, setUserMenuActive] = useState(false);
  const [searchValue, setSearchValue] = useState('');

  const toggleMobileNav = useCallback(() => setMobileNavActive((a) => !a), []);
  const toggleUserMenu = useCallback(() => setUserMenuActive((a) => !a), []);

  const badgeFor = (key?: CountKey) => (key ? String(counts[key]) : undefined);

  const navItems = NAV_ROUTES.map((route) => ({
    url: route.path,
    label: route.label,
    icon: route.icon,
    // Exact match for "/" so it isn't perpetually selected; prefix match otherwise.
    selected: route.path === '/' ? pathname === '/' : pathname.startsWith(route.path),
    badge: badgeFor(route.countKey),
  }));

  const userMenu = (
    <TopBar.UserMenu
      name={shop.name}
      detail={`${shop.plan} plan`}
      initials={shop.initials}
      open={userMenuActive}
      onToggle={toggleUserMenu}
      actions={[
        {
          items: [
            { content: 'Store settings' },
            { content: 'Back to Shopify admin' },
          ],
        },
      ]}
    />
  );

  const searchField = (
    <TopBar.SearchField
      onChange={setSearchValue}
      value={searchValue}
      placeholder="Search"
    />
  );

  const topBar = (
    <TopBar
      showNavigationToggle
      userMenu={userMenu}
      searchField={searchField}
      onNavigationToggle={toggleMobileNav}
    />
  );

  const shopifyItems = [
    { url: '#', label: 'Home', icon: HomeIcon, disabled: true },
    { url: '#', label: 'Orders', icon: OrderIcon, disabled: true, badge: '12' },
    { url: '#', label: 'Products', icon: ProductIcon, disabled: true },
    {
      url: '/shopify-discounts',
      label: 'Discounts',
      icon: DiscountIcon,
      selected: pathname === '/shopify-discounts',
    },
  ];

  const navigation = (
    <Navigation location={pathname}>
      <Navigation.Section items={shopifyItems} />
      <Navigation.Section title="Discount Engine" items={navItems} />
    </Navigation>
  );

  return (
    <Frame
      logo={{
        topBarSource: LOGO_SRC,
        width: 32,
        accessibilityLabel: 'Discount Engine',
        url: '/',
      }}
      topBar={topBar}
      navigation={navigation}
      showMobileNavigation={mobileNavActive}
      onNavigationDismiss={toggleMobileNav}
    >
      {children}
    </Frame>
  );
}
