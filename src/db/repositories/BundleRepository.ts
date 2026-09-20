import { eq } from 'drizzle-orm';
import { bundle } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type BundleRow = typeof bundle.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type BundleNew = Omit<typeof bundle.$inferInsert, 'shopId'>;

/** The contract handlers depend on — generic CRUD plus the one narrow update below. */
export interface IBundleRepository extends IShopScopedRepository<BundleRow, BundleNew> {
  setMetafieldState(
    id: string,
    state: BundleRow['metafieldState'],
    metafieldGid: string | null,
  ): Promise<void>;
}

/**
 * E6 bundles. Nothing here passes a shop id: it came in through the
 * constructor and `scope()` welds `shop_id = ?` onto every read and write, so
 * another shop's bundle reads as absent rather than being mutated.
 */
export class BundleRepository
  extends ShopScopedRepository<typeof bundle>
  implements IBundleRepository
{
  constructor(db: Db, shopId: string) {
    super(db, bundle, shopId);
  }

  /**
   * Narrow update for the metafield-transport bookkeeping the bundle routes do
   * after each Admin API write/clear. The two columns move together —
   * `metafieldGid` is meaningless unless `metafieldState` agrees — so they are
   * set through one method rather than an open-ended patch. It deliberately
   * does not bump `updatedAt`: this is transport bookkeeping, not a merchant
   * edit of the bundle.
   */
  async setMetafieldState(
    id: string,
    state: BundleRow['metafieldState'],
    metafieldGid: string | null,
  ): Promise<void> {
    await this.db
      .update(bundle)
      .set({ metafieldState: state, metafieldGid })
      .where(this.scope(eq(bundle.id, id)));
  }
}
