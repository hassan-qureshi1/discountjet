import { and, eq, isNull } from 'drizzle-orm';
import { discount } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type DiscountRow = typeof discount.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type DiscountNew = Omit<typeof discount.$inferInsert, 'shopId'>;

/** The contract handlers and the sync module depend on. */
export interface IDiscountRepository extends IShopScopedRepository<DiscountRow, DiscountNew> {
  listLive(): Promise<DiscountRow[]>;
  findVersionByGid(shopifyGid: string): Promise<{ id: string; updatedAt: string | null } | null>;
  insertMirror(row: DiscountNew): Promise<void>;
  updateMirror(id: string, patch: Partial<DiscountNew>): Promise<void>;
  tombstoneByGid(shopifyGid: string, deletedAt: string): Promise<void>;
  listLiveGids(): Promise<string[]>;
  countUnknownType(): Promise<number>;
}

/**
 * The app-owned mirror of Shopify discounts. Shopify is the source of truth;
 * these rows are a queryable copy kept in sync by the `discounts/*` webhooks
 * and the reconcile pass.
 *
 * `findById` (from the base) returns tombstoned rows as-is — the caller decides
 * whether a `deletedAt` row is a 404 or a resurrection candidate, because the
 * reconcile pass needs to see them.
 */
export class DiscountRepository
  extends ShopScopedRepository<typeof discount>
  implements IDiscountRepository
{
  constructor(db: Db, shopId: string) {
    super(db, discount, shopId);
  }

  /** The shop + Shopify-GID pair is the mirror's upsert key. */
  private byGid(shopifyGid: string) {
    return this.scope(eq(discount.shopifyGid, shopifyGid));
  }

  /** Live (non-tombstoned) discounts for this shop. */
  async listLive(): Promise<DiscountRow[]> {
    return this.db
      .select()
      .from(discount)
      .where(this.scope(isNull(discount.deletedAt)))
      .all();
  }

  /** Just enough of the mirror row to apply the `updated_at` ordering guard. */
  async findVersionByGid(
    shopifyGid: string,
  ): Promise<{ id: string; updatedAt: string | null } | null> {
    const row = await this.db
      .select({ id: discount.id, updatedAt: discount.updatedAt })
      .from(discount)
      .where(this.byGid(shopifyGid))
      .get();
    return row ?? null;
  }

  /**
   * Mirror insert, deliberately bypassing the base `create()` for the same
   * reason `updateMirror` bypasses `update()`: `createdAt`/`updatedAt` are
   * Shopify's values, not ours, and `create()` would stamp them with now.
   * The tenant is still injected here, so the caller cannot set it.
   */
  async insertMirror(row: DiscountNew): Promise<void> {
    await this.db.insert(discount).values({ ...row, shopId: this.shopId });
  }

  /**
   * Mirror write, deliberately bypassing the base `update()`.
   *
   * `discount.updatedAt` is a copy of SHOPIFY's `updated_at`, not ours — it is
   * what the sync's ordering guard compares against to drop a stale webhook.
   * The base `update()` stamps `updatedAt` with the current time, which would
   * overwrite Shopify's value and defeat that guard, so the mirror path writes
   * the patch through verbatim. Still scoped: `scope()` is applied here too.
   */
  async updateMirror(id: string, patch: Partial<DiscountNew>): Promise<void> {
    await this.db
      .update(discount)
      .set(patch)
      .where(this.scope(eq(discount.id, id)));
  }

  /** Tombstones the mirror row for a GID (webhook delete, or a reconcile diff). */
  async tombstoneByGid(shopifyGid: string, deletedAt: string): Promise<void> {
    await this.db.update(discount).set({ deletedAt }).where(this.byGid(shopifyGid));
  }

  /** GIDs of every live mirror row — the left side of the reconcile diff. */
  async listLiveGids(): Promise<string[]> {
    const rows = await this.db
      .select({ shopifyGid: discount.shopifyGid })
      .from(discount)
      .where(this.scope(isNull(discount.deletedAt)))
      .all();
    return rows.map((r) => r.shopifyGid);
  }

  /** Live rows whose engine type is still unknown (config metafield unseen). */
  async countUnknownType(): Promise<number> {
    const rows = await this.db
      .select({ id: discount.id })
      .from(discount)
      .where(this.scope(and(isNull(discount.deletedAt), isNull(discount.type))))
      .all();
    return rows.length;
  }
}
