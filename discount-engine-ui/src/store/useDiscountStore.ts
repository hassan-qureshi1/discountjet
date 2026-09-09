import { create } from 'zustand';
import type {
  BundleCampaign,
  Campaign,
  CampaignTemplate,
  CartTransform,
  Discount,
  OverviewData,
  PlanData,
  Shop,
  ShopifyDiscount,
  Template,
} from '../types';

import { fetchDiscounts, fetchShopifyDiscounts } from '../api';

// Hardcoded fixtures seed the store; from then on the app mutates it in memory,
// so created discounts/campaigns/bundles persist and appear in the lists (until
// a page refresh reseeds). The `discounts` slice is now hydrated from the live
// `GET /api/discounts` mirror (E4) — see hydrateDiscountsFromApi below — while
// the other slices still seed from fixtures until their epics land.
import shopData from '../data/shop.json';
import overviewData from '../data/overview.json';
import discountsData from '../data/discounts.json';
import cartTransformsData from '../data/cartTransforms.json';
import bundleCampaignsData from '../data/bundleCampaigns.json';
import campaignsData from '../data/campaigns.json';
import templatesData from '../data/templates.json';
import campaignTemplatesData from '../data/campaignTemplates.json';
import shopifyDiscountsData from '../data/shopifyDiscounts.json';
import planData from '../data/plan.json';

interface DiscountStoreState {
  shop: Shop;
  overview: OverviewData;
  discounts: Discount[];
  cartTransforms: CartTransform[];
  campaigns: Campaign[];
  bundleCampaigns: BundleCampaign[];
  templates: Template[];
  campaignTemplates: CampaignTemplate[];
  shopifyDiscounts: ShopifyDiscount[];
  plan: PlanData;

  // ── Mutations (in-memory persistence) ──
  addDiscount: (discount: Discount) => void;
  updateDiscount: (id: string, patch: Partial<Discount>) => void;
  addBundle: (bundle: CartTransform) => void;
  updateBundle: (id: string, patch: Partial<CartTransform>) => void;
  addCampaign: (campaign: Campaign) => void;
  addBundleCampaign: (campaign: BundleCampaign) => void;
  updateBundleCampaign: (id: string, patch: Partial<BundleCampaign>) => void;
}

export const useDiscountStore = create<DiscountStoreState>((set) => ({
  shop: shopData as Shop,
  overview: overviewData as OverviewData,
  discounts: discountsData as Discount[],
  cartTransforms: cartTransformsData as CartTransform[],
  campaigns: campaignsData as Campaign[],
  bundleCampaigns: bundleCampaignsData as BundleCampaign[],
  templates: templatesData as Template[],
  campaignTemplates: campaignTemplatesData as CampaignTemplate[],
  shopifyDiscounts: shopifyDiscountsData as ShopifyDiscount[],
  plan: planData as PlanData,

  addDiscount: (discount) => set((s) => ({ discounts: [discount, ...s.discounts] })),
  updateDiscount: (id, patch) =>
    set((s) => ({ discounts: s.discounts.map((d) => (d.id === id ? { ...d, ...patch } : d)) })),
  addBundle: (bundle) => set((s) => ({ cartTransforms: [bundle, ...s.cartTransforms] })),
  updateBundle: (id, patch) =>
    set((s) => ({ cartTransforms: s.cartTransforms.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
  addCampaign: (campaign) => set((s) => ({ campaigns: [campaign, ...s.campaigns] })),
  addBundleCampaign: (campaign) => set((s) => ({ bundleCampaigns: [campaign, ...s.bundleCampaigns] })),
  updateBundleCampaign: (id, patch) =>
    set((s) => ({ bundleCampaigns: s.bundleCampaigns.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
}));

// ─── Selector hooks — the only way pages read data ───────────────────────────
export const useShop = () => useDiscountStore((s) => s.shop);
export const useOverview = () => useDiscountStore((s) => s.overview);
export const useDiscounts = () => useDiscountStore((s) => s.discounts);
export const useCartTransforms = () => useDiscountStore((s) => s.cartTransforms);
export const useCampaigns = () => useDiscountStore((s) => s.campaigns);
export const useTemplates = () => useDiscountStore((s) => s.templates);
export const useCampaignTemplates = () => useDiscountStore((s) => s.campaignTemplates);
export const useShopifyDiscounts = () => useDiscountStore((s) => s.shopifyDiscounts);
export const usePlan = () => useDiscountStore((s) => s.plan);

// Single-item lookups used by detail / edit routes.
export const useDiscount = (id?: string) =>
  useDiscountStore((s) => s.discounts.find((d) => d.id === id));
export const useCampaign = (id?: string) =>
  useDiscountStore((s) => s.campaigns.find((c) => c.id === id));
export const useCartTransform = (id?: string) =>
  useDiscountStore((s) => s.cartTransforms.find((t) => t.id === id));
export const useBundleCampaigns = () => useDiscountStore((s) => s.bundleCampaigns);
export const useBundleCampaign = (id?: string) =>
  useDiscountStore((s) => s.bundleCampaigns.find((c) => c.id === id));
export const useTemplate = (id?: string) =>
  useDiscountStore((s) => s.templates.find((t) => t.id === id));

// ─── Live sync (E4) ──────────────────────────────────────────────────────────
// Replace the seeded `discounts` with the webhook-synced mirror from the Worker.
// Runs once on load; keeps the fixture seed as a fallback if the API is
// unreachable (e.g. pure localhost dev without an authenticated session) so the
// page always renders. `Discounts.tsx` / `useDiscounts` are untouched.
export function hydrateDiscountsFromApi(): void {
  if (typeof window === 'undefined') return;
  fetchDiscounts()
    .then(({ discounts }) => useDiscountStore.setState({ discounts }))
    .catch((err) => console.warn('[discounts] live sync unavailable, using seed data:', err));
}

// Replace the seeded `shopifyDiscounts` with the live native+app list from the
// Worker (GET /api/shopify-discounts). Same fallback-to-seed behavior; the
// native view page (`ShopifyDiscounts.tsx`) and `useShopifyDiscounts` are untouched.
export function hydrateShopifyDiscountsFromApi(): void {
  if (typeof window === 'undefined') return;
  fetchShopifyDiscounts()
    .then(({ shopifyDiscounts }) => useDiscountStore.setState({ shopifyDiscounts }))
    .catch((err) => console.warn('[shopify-discounts] live sync unavailable, using seed data:', err));
}

hydrateDiscountsFromApi();
hydrateShopifyDiscountsFromApi();

// ─── Action hooks ────────────────────────────────────────────────────────────
export const useAddDiscount = () => useDiscountStore((s) => s.addDiscount);
export const useUpdateDiscount = () => useDiscountStore((s) => s.updateDiscount);
export const useAddBundle = () => useDiscountStore((s) => s.addBundle);
export const useUpdateBundle = () => useDiscountStore((s) => s.updateBundle);
export const useAddCampaign = () => useDiscountStore((s) => s.addCampaign);
export const useAddBundleCampaign = () => useDiscountStore((s) => s.addBundleCampaign);
export const useUpdateBundleCampaign = () => useDiscountStore((s) => s.updateBundleCampaign);
