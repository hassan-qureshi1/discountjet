import { asc, eq, getTableName, sql } from 'drizzle-orm';
import { bundleItem } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

// Drizzle strips table qualification from SELECT-list expressions on a
// single-table query (no joins) — see `buildSelection`'s `isSingleTable`
// branch. That is fine for plain columns, but it also flattens columns
// referenced *inside* a `sql` template, which would otherwise leave `price`
// and `qty` ambiguous once callers start reading these aggregates' SQL (and
// is what `BundleItemRepository.test.ts` asserts on). Interpolating
// `sql.identifier(...)` fragments instead of the `Column` objects themselves
// sidesteps that rewrite, since only literal `Column` chunks get stripped.
const TABLE = sql.identifier(getTableName(bundleItem));
const PRICE = sql`${TABLE}.${sql.identifier(bundleItem.price.name)}`;
const QTY = sql`${TABLE}.${sql.identifier(bundleItem.qty.name)}`;

export type BundleItemRow = typeof bundleItem.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type BundleItemNew = Omit<typeof bundleItem.$inferInsert, 'shopId'>;

/** What a caller hands `replaceForBundle`: the repository mints the rest. */
export type BundleItemDraft = Omit<
  BundleItemNew,
  'id' | 'bundleId' | 'createdAt' | 'updatedAt'
>;

export interface IBundleItemRepository
  extends IShopScopedRepository<BundleItemRow, BundleItemNew> {
  listForBundle(bundleId: string): Promise<BundleItemRow[]>;
  replaceForBundle(bundleId: string, items: BundleItemDraft[]): Promise<BundleItemRow[]>;
  sumFor(bundleId: string): Promise<number | null>;
  sumsByBundle(): Promise<Map<string, number>>;
}

/**
 * Bundle components. The bundle's total is never stored — `sumFor` computes it
 * — so it cannot disagree with the rows it totals.
 */
export class BundleItemRepository
  extends ShopScopedRepository<typeof bundleItem>
  implements IBundleItemRepository
{
  constructor(db: Db, shopId: string) {
    super(db, bundleItem, shopId);
  }

  /** Ordered by name: there is no `position`, see the schema comment. */
  async listForBundle(bundleId: string): Promise<BundleItemRow[]> {
    return this.db
      .select()
      .from(bundleItem)
      .where(this.scope(eq(bundleItem.bundleId, bundleId)))
      .orderBy(asc(bundleItem.name))
      .all();
  }

  /**
   * Swaps a bundle's whole component set in ONE `db.batch()`.
   *
   * D1 has no interactive transactions, so a delete-then-insert issued as
   * separate statements can leave a bundle with no components if the insert
   * fails. A batch is applied atomically, which is the only reason this is a
   * repository method rather than a loop in the route.
   */
  async replaceForBundle(bundleId: string, items: BundleItemDraft[]): Promise<BundleItemRow[]> {
    const now = new Date().toISOString();
    const rows: BundleItemRow[] = items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      shopId: this.shopId,
      bundleId,
      priceAdjustment: item.priceAdjustment ?? null,
      titleOverride: item.titleOverride ?? null,
      createdAt: now,
      updatedAt: now,
    }));

    const clear = this.db
      .delete(bundleItem)
      .where(this.scope(eq(bundleItem.bundleId, bundleId)));

    if (rows.length === 0) {
      await clear;
      return [];
    }

    await this.db.batch([
      clear,
      ...rows.map((row) => this.db.insert(bundleItem).values(row)),
    ] as unknown as Parameters<typeof this.db.batch>[0]);

    return rows;
  }

  /** `sum(price * qty)` for one bundle, in minor units. Null when it has no items. */
  async sumFor(bundleId: string): Promise<number | null> {
    const row = await this.db
      .select({ total: sql<number | null>`sum(${PRICE} * ${QTY})`.as('total') })
      .from(bundleItem)
      .where(this.scope(eq(bundleItem.bundleId, bundleId)))
      .get();
    return row?.total ?? null;
  }

  /**
   * Every bundle's total in one grouped query. `GET /api/bundles` renders a
   * savings column per row, so a per-bundle sum would be N+1 across the list.
   */
  async sumsByBundle(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        // Aliased explicitly, matching the fake D1's key extraction — the
        // fake reads raw driver rows back by the SQL's own column/alias
        // names, so a select field without `.as(...)` (plain columns are
        // never aliased by Drizzle on a single-table query) would look up
        // the wrong key.
        bundleId: sql<string>`${bundleItem.bundleId}`.as('bundleId'),
        total: sql<number>`sum(${PRICE} * ${QTY})`.as('total'),
      })
      .from(bundleItem)
      .where(this.scope())
      .groupBy(bundleItem.bundleId)
      .all();
    return new Map(rows.map((r) => [r.bundleId, r.total]));
  }
}
