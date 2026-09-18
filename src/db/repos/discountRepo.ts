import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { discount } from '../schema';

export type DiscountRow = typeof discount.$inferSelect;
export type DiscountInsert = typeof discount.$inferInsert;

/**
 * Queries against `discount` — the app-owned mirror of Shopify discounts.
 * Shopify is the source of truth; these rows are a queryable copy kept in
 * sync by the `discounts/*` webhooks and the reconcile pass.
 */
export class DiscountRepository {
  constructor(private readonly db: Db) {}

  /** The tenant boundary for id-addressed rows — see `BundleRepository`. */
  private scoped(shopId: string, id: string) {
    return and(eq(discount.id, id), eq(discount.shopId, shopId));
  }

  /** The shop + Shopify-GID pair is the mirror's upsert key. */
  private byGid(shopId: string, shopifyGid: string) {
    return and(eq(discount.shopId, shopId), eq(discount.shopifyGid, shopifyGid));
  }

  /** Live (non-tombstoned) discounts for a shop. */
  async listLive(shopId: string): Promise<DiscountRow[]> {
    return this.db
      .select()
      .from(discount)
      .where(and(eq(discount.shopId, shopId), isNull(discount.deletedAt)))
      .all();
  }

  /**
   * Single discount scoped to the shop. Tombstoned rows are returned as-is —
   * the caller decides whether a `deletedAt` row is a 404 or a resurrection
   * candidate (the reconcile pass needs to see them).
   */
  async find(shopId: string, id: string): Promise<DiscountRow | null> {
    const row = await this.db.select().from(discount).where(this.scoped(shopId, id)).get();
    return row ?? null;
  }

  /** Just enough of the mirror row to apply the `updated_at` ordering guard. */
  async findVersionByGid(
    shopId: string,
    shopifyGid: string,
  ): Promise<{ id: string; updatedAt: string | null } | null> {
    const row = await this.db
      .select({ id: discount.id, updatedAt: discount.updatedAt })
      .from(discount)
      .where(this.byGid(shopId, shopifyGid))
      .get();
    return row ?? null;
  }

  async insert(row: DiscountInsert): Promise<void> {
    await this.db.insert(discount).values(row);
  }

  /**
   * Update by primary key. The sync path has already resolved the row via
   * `findVersionByGid`, so the shop scope was applied on the way in.
   */
  async updateById(id: string, patch: Partial<DiscountRow>): Promise<void> {
    await this.db.update(discount).set(patch).where(eq(discount.id, id));
  }

  /** Tombstones the mirror row for a GID (webhook delete, or a reconcile diff). */
  async tombstoneByGid(shopId: string, shopifyGid: string, deletedAt: string): Promise<void> {
    await this.db.update(discount).set({ deletedAt }).where(this.byGid(shopId, shopifyGid));
  }

  /** GIDs of every live mirror row — the left side of the reconcile diff. */
  async listLiveGids(shopId: string): Promise<string[]> {
    const rows = await this.db
      .select({ shopifyGid: discount.shopifyGid })
      .from(discount)
      .where(and(eq(discount.shopId, shopId), isNull(discount.deletedAt)))
      .all();
    return rows.map((r) => r.shopifyGid);
  }

  /** Live rows whose engine type is still unknown (config metafield unseen). */
  async countUnknownType(shopId: string): Promise<number> {
    const rows = await this.db
      .select({ id: discount.id })
      .from(discount)
      .where(and(eq(discount.shopId, shopId), isNull(discount.deletedAt), isNull(discount.type)))
      .all();
    return rows.length;
  }
}
