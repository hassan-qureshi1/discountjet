import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/db';
import { discount, shopifyShop } from '../db/schema';
import { adminGraphql } from '../lib/graphqlAdmin';
import { kindAndConfig, type DiscountKind } from '../lifecycle/discountSync';
import type { AppEnv } from '../types/env.d';

export const shopifyDiscountRoutes = new Hono<AppEnv>();

// ─── Pure mapping helpers (unit-tested) ───────────────────────────────────────

/** Shopify `DiscountStatus` preserved as the native view's tri-state label. */
export function shopifyStatusLabel(status: string | undefined): 'Active' | 'Scheduled' | 'Expired' {
  if (status === 'SCHEDULED') return 'Scheduled';
  if (status === 'EXPIRED') return 'Expired';
  return 'Active';
}

/** Node `__typename` → discount method label. */
export function methodLabel(typename: string): 'Automatic' | 'Code' {
  return typename.startsWith('DiscountCode') ? 'Code' : 'Automatic';
}

const ENGINE_LABEL: Record<DiscountKind, 'Tier' | 'Bundle' | 'Split'> = {
  tier: 'Tier',
  bundle: 'Bundle',
  special: 'Split', // the special engine renders as "Split" in the native view
};

const ENGINE_TYPE_LABEL: Record<DiscountKind, string> = {
  tier: 'Discount Engine · Volume',
  bundle: 'Discount Engine · Buy X, get Y',
  special: 'Discount Engine · Buy X, discount both',
};

/** Engine kind → native-view engine badge label. */
export function engineLabel(kind: DiscountKind): 'Tier' | 'Bundle' | 'Split' {
  return ENGINE_LABEL[kind];
}

/** Engine kind → merchant-facing type label for an app discount. */
export function engineTypeLabel(kind: DiscountKind): string {
  return ENGINE_TYPE_LABEL[kind];
}

/** Native (non-app) discount `__typename` → a human type label. */
export function nativeTypeLabel(typename: string): string {
  if (typename.includes('FreeShipping')) return 'Free shipping';
  if (typename.includes('Bxgy')) return 'Buy X, get Y';
  if (typename.includes('App')) return 'App discount';
  if (typename.includes('Basic')) return 'Amount off products';
  return 'Discount';
}

export interface ShopifyListNode {
  id: string;
  discount: {
    __typename: string;
    title?: string;
    status?: string;
    asyncUsageCount?: number;
  } | null;
  tier?: { value: string } | null;
  bundle?: { value: string } | null;
  special?: { value: string } | null;
}

export interface ShopifyDiscountDto {
  id: string;
  title: string;
  status: 'Active' | 'Scheduled' | 'Expired';
  method: 'Automatic' | 'Code';
  type: string;
  engine: 'Tier' | 'Bundle' | 'Split' | null;
  appId?: string;
  used: number;
}

/**
 * Map a live `discountNode` to the UI `ShopifyDiscount` shape. App-owned nodes
 * (identified by the `$app:` config metafield) get an engine + a `Discount
 * Engine · …` type label and, when mirrored in D1, the app row id (`appId`).
 * Native nodes get `engine: null` and no `appId`.
 */
export function toShopifyDiscount(
  node: ShopifyListNode,
  appIdByGid: Map<string, string>,
): ShopifyDiscountDto {
  const d = node.discount;
  const typename = d?.__typename ?? '';
  const owned = kindAndConfig(node);
  const kind = owned?.kind ?? null;
  const appId = appIdByGid.get(node.id);

  const dto: ShopifyDiscountDto = {
    id: node.id,
    title: d?.title ?? '',
    status: shopifyStatusLabel(d?.status),
    method: methodLabel(typename),
    type: kind ? engineTypeLabel(kind) : nativeTypeLabel(typename),
    engine: kind ? engineLabel(kind) : null,
    used: d?.asyncUsageCount ?? 0,
  };
  return appId ? { ...dto, appId } : dto;
}

// ─── Route ────────────────────────────────────────────────────────────────────

interface ListResponse {
  discountNodes: { nodes: ShopifyListNode[] };
}

const CONFIG = {
  tier: '$app:discount-tier',
  bundle: '$app:discount-bundle',
  special: '$app:discount-special',
};

// Live query: native + app discounts, with each engine's config metafield so
// app ownership + engine kind can be detected without a second round-trip.
const LIST_QUERY = `#graphql
  query ShopifyDiscounts($first: Int!) {
    discountNodes(first: $first, reverse: true) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticApp { title status asyncUsageCount }
          ... on DiscountCodeApp { title status asyncUsageCount }
          ... on DiscountAutomaticBasic { title status asyncUsageCount }
          ... on DiscountCodeBasic { title status asyncUsageCount }
          ... on DiscountAutomaticBxgy { title status asyncUsageCount }
          ... on DiscountCodeBxgy { title status asyncUsageCount }
          ... on DiscountAutomaticFreeShipping { title status asyncUsageCount }
          ... on DiscountCodeFreeShipping { title status asyncUsageCount }
        }
        tier: metafield(namespace: "${CONFIG.tier}", key: "config") { value }
        bundle: metafield(namespace: "${CONFIG.bundle}", key: "config") { value }
        special: metafield(namespace: "${CONFIG.special}", key: "config") { value }
      }
    }
  }`;

// GET /api/shopify-discounts — native + app discounts side by side, live from
// Shopify, with app-owned rows joined to the D1 mirror for `appId`.
shopifyDiscountRoutes.get('/api/shopify-discounts', async (c) => {
  const db = createDb(c.env.DB);
  const shopId = c.get('shopId');

  const shop = await db
    .select({ domain: shopifyShop.myshopifyDomain })
    .from(shopifyShop)
    .where(eq(shopifyShop.id, shopId))
    .get();
  if (!shop?.domain) return c.json({ error: 'Shop domain not found' }, 404);

  const res = await adminGraphql<ListResponse>(shop.domain, c.env, LIST_QUERY, { first: 100 });
  const nodes = res.data?.discountNodes?.nodes ?? [];

  // Join app-owned nodes to their D1 row id by shopifyGid.
  const rows = await db
    .select({ id: discount.id, shopifyGid: discount.shopifyGid })
    .from(discount)
    .where(and(eq(discount.shopId, shopId), isNull(discount.deletedAt)))
    .all();
  const appIdByGid = new Map(rows.map((r) => [r.shopifyGid, r.id]));

  return c.json({ shopifyDiscounts: nodes.map((n) => toShopifyDiscount(n, appIdByGid)) });
});
