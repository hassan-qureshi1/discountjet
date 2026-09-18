import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { bundle } from '../schema';

export type BundleRow = typeof bundle.$inferSelect;

/** Queries against `bundle`. One instance per request — see `ShopRepository`. */
export class BundleRepository {
  constructor(private readonly db: Db) {}

  /**
   * The tenant boundary, in one place: every row-scoped query filters on
   * `shopId` as well as the row id. Keeping the pair here means a handler
   * cannot leak another shop's bundle by forgetting the second clause.
   */
  private scoped(shopId: string, id: string) {
    return and(eq(bundle.id, id), eq(bundle.shopId, shopId));
  }

  async list(shopId: string): Promise<BundleRow[]> {
    return this.db.select().from(bundle).where(eq(bundle.shopId, shopId)).all();
  }

  async find(shopId: string, id: string): Promise<BundleRow | null> {
    const row = await this.db.select().from(bundle).where(this.scoped(shopId, id)).get();
    return row ?? null;
  }

  async insert(row: BundleRow): Promise<void> {
    await this.db.insert(bundle).values(row);
  }

  async update(shopId: string, id: string, patch: Partial<BundleRow>): Promise<void> {
    await this.db.update(bundle).set(patch).where(this.scoped(shopId, id));
  }

  /**
   * Narrow update for the metafield-transport bookkeeping the bundle routes do
   * after each Admin API write/clear. The two columns move together —
   * `metafieldGid` is meaningless unless `metafieldState` agrees — so they are
   * set through one method rather than an open-ended patch.
   */
  async setMetafieldState(
    shopId: string,
    id: string,
    state: BundleRow['metafieldState'],
    metafieldGid: string | null,
  ): Promise<void> {
    await this.db
      .update(bundle)
      .set({ metafieldState: state, metafieldGid })
      .where(this.scoped(shopId, id));
  }

  async delete(shopId: string, id: string): Promise<void> {
    await this.db.delete(bundle).where(this.scoped(shopId, id));
  }
}
