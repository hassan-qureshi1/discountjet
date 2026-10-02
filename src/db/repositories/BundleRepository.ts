import { and, eq, isNull } from 'drizzle-orm';
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
  capturePreSalePrice(id: string, priceMinor: number): Promise<BundleRow | null>;
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

  /**
   * Compare-and-set: writes the pre-sale capture ONLY while the column is
   * still null, and returns the row it won — or null when someone else had
   * already captured.
   *
   * `pre_sale_price` is the entire restore guarantee, and the schema states it
   * is written once and never while already non-null. A plain `update()` makes
   * that a convention held up by `decideSaleAction`, which reads the row at the
   * top of a pass: two overlapping cron passes (the trigger is every five
   * minutes, with no overlap guard, and each live bundle now costs two Admin
   * subrequests) can both decide `apply` from the same pre-sale read, and the
   * second would overwrite the real price with the SALE price the first just
   * wrote. A single conditional UPDATE is atomic in D1, so the capture IS the
   * gate: the loser gets null and declines to apply, having touched nothing.
   */
  async capturePreSalePrice(id: string, priceMinor: number): Promise<BundleRow | null> {
    const row = await this.db
      .update(bundle)
      .set({ preSalePrice: priceMinor, updatedAt: new Date().toISOString() })
      .where(this.scope(and(eq(bundle.id, id), isNull(bundle.preSalePrice))))
      .returning()
      .get();
    return (row as BundleRow | undefined) ?? null;
  }
}
