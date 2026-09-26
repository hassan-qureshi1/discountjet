import { and, eq, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { BaseRepository, type Db, type RepositoryTable } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type ShopScopedTable = RepositoryTable & { shopId: AnySQLiteColumn };

/**
 * Base for every table that belongs to a shop.
 *
 * The constructor requires a shopId, so a scoped repository is unconstructible
 * without a tenant — the isolation is a property of the type, not a convention
 * each query has to remember. Every read and write goes through `scope()`, and
 * inserts carry the shop regardless of what the caller passed.
 */
export abstract class ShopScopedRepository<
    TTable extends ShopScopedTable,
    TRow = TTable['$inferSelect'],
    // shopId is dropped from the write type: the repository supplies it, and a
    // caller trying to pass one for another shop does not compile.
    TNew = Omit<TTable['$inferInsert'], 'shopId'>,
  >
  extends BaseRepository<TTable, TRow, TNew>
  implements IShopScopedRepository<TRow, TNew>
{
  protected constructor(
    db: Db,
    table: TTable,
    public readonly shopId: string,
  ) {
    super(db, table);
  }

  protected override scope(extra?: SQL): SQL | undefined {
    return and(eq(this.table.shopId, this.shopId), extra);
  }

  protected override scopedValues(): Record<string, unknown> {
    return { shopId: this.shopId };
  }
}
