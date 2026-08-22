import { create } from 'zustand';
import type {
  Campaign,
  CampaignTemplate,
  CartTransform,
  Discount,
  OverviewData,
  PlanData,
  Shop,
  Template,
} from '../types';

// Hardcoded fixtures — the single source of truth for the demo. They are loaded
// here once and read everywhere through the store, so the UI behaves as if the
// data came from a real backend (swap these imports for API calls later).
import shopData from '../data/shop.json';
import overviewData from '../data/overview.json';
import discountsData from '../data/discounts.json';
import cartTransformsData from '../data/cartTransforms.json';
import campaignsData from '../data/campaigns.json';
import templatesData from '../data/templates.json';
import campaignTemplatesData from '../data/campaignTemplates.json';
import planData from '../data/plan.json';

interface DiscountStoreState {
  shop: Shop;
  overview: OverviewData;
  discounts: Discount[];
  cartTransforms: CartTransform[];
  campaigns: Campaign[];
  templates: Template[];
  campaignTemplates: CampaignTemplate[];
  plan: PlanData;
}

export const useDiscountStore = create<DiscountStoreState>(() => ({
  shop: shopData as Shop,
  overview: overviewData as OverviewData,
  discounts: discountsData as Discount[],
  cartTransforms: cartTransformsData as CartTransform[],
  campaigns: campaignsData as Campaign[],
  templates: templatesData as Template[],
  campaignTemplates: campaignTemplatesData as CampaignTemplate[],
  plan: planData as PlanData,
}));

// ─── Selector hooks — the only way pages read data ───────────────────────────
export const useShop = () => useDiscountStore((s) => s.shop);
export const useOverview = () => useDiscountStore((s) => s.overview);
export const useDiscounts = () => useDiscountStore((s) => s.discounts);
export const useCartTransforms = () => useDiscountStore((s) => s.cartTransforms);
export const useCampaigns = () => useDiscountStore((s) => s.campaigns);
export const useTemplates = () => useDiscountStore((s) => s.templates);
export const useCampaignTemplates = () => useDiscountStore((s) => s.campaignTemplates);
export const usePlan = () => useDiscountStore((s) => s.plan);

// Single-item lookups used by detail / edit routes.
export const useDiscount = (id?: string) =>
  useDiscountStore((s) => s.discounts.find((d) => d.id === id));
export const useCampaign = (id?: string) =>
  useDiscountStore((s) => s.campaigns.find((c) => c.id === id));
export const useCartTransform = (id?: string) =>
  useDiscountStore((s) => s.cartTransforms.find((t) => t.id === id));
export const useTemplate = (id?: string) =>
  useDiscountStore((s) => s.templates.find((t) => t.id === id));
