import { Hono } from 'hono';
import { adminGraphql } from '../lib/graphqlAdmin';
import type { AppEnv } from '../types/env.d';

export const shopRoutes = new Hono<AppEnv>();

interface ShopPlanDto {
  updateOpEligible: boolean;
  planName: string | null;
  currencyCode: string;
}

interface ShopPlanQueryResult {
  shop: {
    plan: {
      shopifyPlus: boolean;
      partnerDevelopment: boolean;
      displayName: string;
    };
  };
}

const SHOP_PLAN_QUERY = /* GraphQL */ `
  query ShopPlan {
    shop {
      plan {
        shopifyPlus
        partnerDevelopment
        displayName
      }
    }
  }
`;

// GET /api/shop/plan — whether this store is eligible for the Plus-gated
// bundle `update` operation, cached on the shop row after the first Admin
// GraphQL lookup. `bundlesEligible`/`BundlesFeature` is deferred (E6 later
// slice) — this endpoint assumes bundles are eligible.
shopRoutes.get('/api/shop/plan', async (c) => {
  const shops = c.get('repos').shops;
  const shopId = c.get('shopId');

  const shop = await shops.findById(shopId);
  if (!shop?.myshopifyDomain) return c.json({ error: 'Shop domain not found' }, 404);
  if (!shop.currency) {
    return c.json({ error: 'This shop has no currency on its row.' }, 500);
  }

  if (shop.shopifyPlus !== null && shop.partnerDevelopment !== null) {
    const dto: ShopPlanDto = {
      updateOpEligible: shop.shopifyPlus === 1 || shop.partnerDevelopment === 1,
      planName: shop.planName,
      currencyCode: shop.currency,
    };
    return c.json(dto);
  }

  const result = await adminGraphql<ShopPlanQueryResult>(shop.myshopifyDomain, c.env, SHOP_PLAN_QUERY);
  const plan = result.data?.shop.plan;
  if (!plan) {
    throw new Error(
      `[shop/plan] adminGraphql returned no plan for ${shop.myshopifyDomain}: ${JSON.stringify(result.errors)}`,
    );
  }

  await shops.updatePlanCache(shopId, {
    shopifyPlus: plan.shopifyPlus,
    partnerDevelopment: plan.partnerDevelopment,
    planName: plan.displayName,
  });

  const dto: ShopPlanDto = {
    updateOpEligible: plan.shopifyPlus || plan.partnerDevelopment,
    planName: plan.displayName,
    currencyCode: shop.currency,
  };
  return c.json(dto);
});
