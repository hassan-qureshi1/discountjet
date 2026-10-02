import {
  and, count, desc, eq, isNull,
} from 'drizzle-orm';
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
  overviewCounts(): Promise<BundleOverviewCounts>;
  listRecentlyScheduled(limit: number): Promise<BundleRow[]>;
}

/**
 * The bundle half of the Overview dashboard.
 *
 * `byOperation` carries `update` even though the picker no longer offers it
 * (`web/bundles/ops.ts`): existing rows may still hold it, and a dashboard that
 * counted six bundles while its breakdown summed to five would be wrong in the
 * one place a merchant goes to be told what is true.
 */
export interface BundleOverviewCounts {
  total: number;
  byStatus: { Draft: number; Scheduled: number; Active: number; Ended: number };
  byOperation: { merge: number; expand: number; update: number };
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

  /** Status and operation totals for the dashboard, in one grouped query. */
  async overviewCounts(): Promise<BundleOverviewCounts> {
    const rows = await this.db
      .select({ status: bundle.status, operation: bundle.operation, n: count() })
      .from(bundle)
      .where(this.scope())
      .groupBy(bundle.status, bundle.operation)
      .all();

    const counts: BundleOverviewCounts = {
      total: 0,
      byStatus: {
        Draft: 0, Scheduled: 0, Active: 0, Ended: 0,
      },
      byOperation: { merge: 0, expand: 0, update: 0 },
    };

    rows.forEach((row) => {
      const n = Number(row.n);
      counts.total += n;
      counts.byStatus[row.status] += n;
      counts.byOperation[row.operation] += n;
    });

    return counts;
  }

  /**
   * The schedule widget's rows: most recently touched first.
   *
   * Ordered by `updatedAt` rather than by window, because a bundle with no
   * window at all is still something the merchant scheduled nothing for and
   * wants to see — ordering by `scheduleStart` would drop every one of them to
   * the bottom behind nulls.
   */
  async listRecentlyScheduled(limit: number): Promise<BundleRow[]> {
    return this.db
      .select()
      .from(bundle)
      .where(this.scope())
      .orderBy(desc(bundle.updatedAt))
      .limit(limit)
      .all();
  }
}
