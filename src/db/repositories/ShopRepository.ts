import { and, eq } from 'drizzle-orm';
import { shopifyShop } from '../schema';
import { BaseRepository, type Db } from './BaseRepository';
import type { IRepository } from './types';

export type ShopRow = typeof shopifyShop.$inferSelect;
export type ShopInsert = typeof shopifyShop.$inferInsert;

/** The identity fields every authenticated request needs (see `requireShop`). */
export type ShopIdentity = Pick<ShopRow, 'id' | 'myshopifyDomain'>;

/** The shop-profile fields hydrated from Shopify at install time. */
export type ShopProfile = Pick<
  ShopRow,
  | 'name'
  | 'email'
  | 'city'
  | 'countryName'
  | 'domain'
  | 'shopOwner'
  | 'currency'
  | 'ianaTimezone'
  | 'primaryLocale'
  | 'plan'
>;

/** The projection `GET /api/example` exposes — internal columns never ship. */
export type ShopProfileDto = {
  name: string | null;
  domain: string | null;
  myshopifyDomain: string | null;
  plan: string | null;
  owner: string | null;
  email: string | null;
  country: string | null;
  currency: string | null;
  installedAt: string | null;
  status: 'installed' | 'uninstalled' | null;
};

/**
 * The contract handlers depend on: the generic CRUD from `IRepository` plus the
 * shop-specific queries below. Handlers name this interface, never the class,
 * so a test can hand them the in-memory implementation instead.
 */
export interface IShopRepository extends IRepository<ShopRow, ShopInsert> {
  findInstalledByDomain(myshopifyDomain: string): Promise<ShopIdentity | null>;
  findIdByDomain(myshopifyDomain: string): Promise<string | null>;
  findProfile(shopId: string): Promise<ShopProfileDto | null>;
  upsertInstalled(row: {
    id: string;
    myshopifyDomain: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  markInstalled(myshopifyDomain: string, profile: ShopProfile, now: string): Promise<void>;
  markUninstalled(myshopifyDomain: string, now: string): Promise<void>;
  updatePlanCache(
    shopId: string,
    plan: { shopifyPlus: boolean; partnerDevelopment: boolean; planName: string },
  ): Promise<void>;
  setCartTransformGid(shopId: string, gid: string): Promise<void>;
}

/**
 * `shopify_shop` is the tenant itself, so it extends BaseRepository directly —
 * there is nothing above it to scope by. Every other table extends
 * ShopScopedRepository.
 *
 * Construct one per request — never cache one at module scope, since a Worker
 * isolate is reused across requests from different shops.
 */
export class ShopRepository extends BaseRepository<typeof shopifyShop> implements IShopRepository {
  constructor(db: Db) {
    super(db, shopifyShop);
  }

  /**
   * Resolves an installed shop by its `*.myshopify.com` domain. Returns the
   * domain alongside the id so the caller can stash both on the request
   * context and skip a second lookup for it (see `requireShopDomain`).
   */
  async findInstalledByDomain(myshopifyDomain: string): Promise<ShopIdentity | null> {
    const row = await this.db
      .select({ id: shopifyShop.id, myshopifyDomain: shopifyShop.myshopifyDomain })
      .from(shopifyShop)
      .where(
        and(eq(shopifyShop.myshopifyDomain, myshopifyDomain), eq(shopifyShop.status, 'installed')),
      )
      .get();
    return row ?? null;
  }

  /**
   * Looks up a shop id by domain regardless of install status — the install
   * flow needs the row it has just written, before `status` is re-read.
   */
  async findIdByDomain(myshopifyDomain: string): Promise<string | null> {
    const row = await this.db
      .select({ id: shopifyShop.id })
      .from(shopifyShop)
      .where(eq(shopifyShop.myshopifyDomain, myshopifyDomain))
      .get();
    return row?.id ?? null;
  }

  /** The deliberately narrow projection served by `GET /api/example`. */
  async findProfile(shopId: string): Promise<ShopProfileDto | null> {
    const row = await this.db
      .select({
        name: shopifyShop.name,
        domain: shopifyShop.domain,
        myshopifyDomain: shopifyShop.myshopifyDomain,
        plan: shopifyShop.plan,
        owner: shopifyShop.shopOwner,
        email: shopifyShop.email,
        country: shopifyShop.countryName,
        currency: shopifyShop.currency,
        installedAt: shopifyShop.installDate,
        status: shopifyShop.status,
      })
      .from(shopifyShop)
      .where(eq(shopifyShop.id, shopId))
      .get();
    return row ?? null;
  }

  /**
   * Creates the shop row on OAuth callback, or re-activates an existing one.
   * `id` is the Shopify offline session id, so a reinstall lands on the same
   * row rather than orphaning the previous one's cascaded data. This is an
   * upsert on a caller-supplied id, so it does not go through `create()`.
   */
  async upsertInstalled(row: {
    id: string;
    myshopifyDomain: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    await this.db
      .insert(shopifyShop)
      .values({
        id: row.id,
        myshopifyDomain: row.myshopifyDomain,
        status: 'installed',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
      .onConflictDoUpdate({
        target: shopifyShop.id,
        set: { status: 'installed', updatedAt: row.updatedAt },
      });
  }

  /** Marks a shop installed and writes the profile fetched from Shopify. */
  async markInstalled(myshopifyDomain: string, profile: ShopProfile, now: string): Promise<void> {
    await this.db
      .update(shopifyShop)
      .set({ ...profile, installDate: now, status: 'installed', updatedAt: now })
      .where(eq(shopifyShop.myshopifyDomain, myshopifyDomain));
  }

  /** Flips a shop to uninstalled (APP_UNINSTALLED webhook). The row is kept. */
  async markUninstalled(myshopifyDomain: string, now: string): Promise<void> {
    await this.db
      .update(shopifyShop)
      .set({ status: 'uninstalled', updatedAt: now })
      .where(eq(shopifyShop.myshopifyDomain, myshopifyDomain));
  }

  /** Caches the Admin-API plan signals on the shop row (`GET /api/shop/plan`). */
  async updatePlanCache(
    shopId: string,
    plan: { shopifyPlus: boolean; partnerDevelopment: boolean; planName: string },
  ): Promise<void> {
    await this.db
      .update(shopifyShop)
      .set({
        shopifyPlus: plan.shopifyPlus ? 1 : 0,
        partnerDevelopment: plan.partnerDevelopment ? 1 : 0,
        planName: plan.planName,
      })
      .where(eq(shopifyShop.id, shopId));
  }

  /** Records the shop's registered cart-transform function GID. */
  async setCartTransformGid(shopId: string, gid: string): Promise<void> {
    await this.db
      .update(shopifyShop)
      .set({ cartTransformGid: gid })
      .where(eq(shopifyShop.id, shopId));
  }
}
