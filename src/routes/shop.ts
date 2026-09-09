import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/db';
import { shopifyShop } from '../db/schema';
import { adminGraphql } from '../lib/graphqlAdmin';
import type { AppEnv } from '../types/env.d';

export const shopRoutes = new Hono<AppEnv>();

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
  const db = createDb(c.env.DB);
  const shopId = c.get('shopId');

  const shop = await db.select().from(shopifyShop).where(eq(shopifyShop.id, shopId)).get();
  if (!shop?.myshopifyDomain) return c.json({ error: 'Shop domain not found' }, 404);

  if (shop.shopifyPlus !== null && shop.partnerDevelopment !== null) {
    return c.json({
      updateOpEligible: shop.shopifyPlus === 1 || shop.partnerDevelopment === 1,
      planName: shop.planName,
    });
  }

  const result = await adminGraphql<ShopPlanQueryResult>(shop.myshopifyDomain, c.env, SHOP_PLAN_QUERY);
  const plan = result.data?.shop.plan;
  if (!plan) {
    throw new Error(
      `[shop/plan] adminGraphql returned no plan for ${shop.myshopifyDomain}: ${JSON.stringify(result.errors)}`,
    );
  }

  await db
    .update(shopifyShop)
    .set({
      shopifyPlus: plan.shopifyPlus ? 1 : 0,
      partnerDevelopment: plan.partnerDevelopment ? 1 : 0,
      planName: plan.displayName,
    })
    .where(eq(shopifyShop.id, shopId));

  return c.json({
    updateOpEligible: plan.shopifyPlus || plan.partnerDevelopment,
    planName: plan.displayName,
  });
});
