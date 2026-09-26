import { eq, getTableName, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db';
import { type IRepository, type NewRow, NotFoundError } from './types';

export type { Db };

/** Any table this layer can manage: a text `id` primary key, per the project's UUID rule. */
export type RepositoryTable = SQLiteTable & { id: AnySQLiteColumn };

/**
 * Generic Drizzle implementation of IRepository. The only place in the codebase
 * that builds queries generically.
 *
 * Every read and write composes its predicate through `scope()`, so a subclass
 * narrows what it can reach by overriding one method rather than rewriting
 * queries — see ShopScopedRepository.
 */
export abstract class BaseRepository<
  TTable extends RepositoryTable,
  TRow = TTable['$inferSelect'],
  TNew = TTable['$inferInsert'],
> implements IRepository<TRow, TNew>
{
  protected constructor(
    protected readonly db: Db,
    protected readonly table: TTable,
  ) {}

  /** Override to narrow every query this repository issues. */
  protected scope(extra?: SQL): SQL | undefined {
    return extra;
  }

  protected get tableName(): string {
    return getTableName(this.table);
  }

  async findById(id: string): Promise<TRow | null> {
    const row = await this.db
      .select()
      .from(this.table as SQLiteTable)
      .where(this.scope(eq(this.table.id, id)))
      .get();
    return (row as TRow | undefined) ?? null;
  }

  async getById(id: string): Promise<TRow> {
    const row = await this.findById(id);
    if (!row) throw new NotFoundError(this.tableName, id);
    return row;
  }

  async findAll(): Promise<TRow[]> {
    const rows = await this.db
      .select()
      .from(this.table as SQLiteTable)
      .where(this.scope());
    return rows as TRow[];
  }

  async create(data: NewRow<TNew>): Promise<TRow> {
    const now = new Date().toISOString();
    const values: Record<string, unknown> = { ...data, ...this.scopedValues() };

    // The project's two data rules live here, so no table added through this
    // layer can get them wrong: UUID ids, ISO-8601 timestamps.
    values.id ??= crypto.randomUUID();
    if (this.hasColumn('createdAt')) values.createdAt ??= now;
    if (this.hasColumn('updatedAt')) values.updatedAt = now;

    const row = await this.db
      .insert(this.table as SQLiteTable)
      .values(values)
      .returning()
      .get();
    return row as TRow;
  }

  async update(id: string, patch: Partial<TNew>): Promise<TRow> {
    const values: Record<string, unknown> = { ...patch };
    if (this.hasColumn('updatedAt')) values.updatedAt = new Date().toISOString();

    const row = await this.db
      .update(this.table as SQLiteTable)
      .set(values)
      .where(this.scope(eq(this.table.id, id)))
      .returning()
      .get();
    if (!row) throw new NotFoundError(this.tableName, id);
    return row as TRow;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(this.table as SQLiteTable)
      .where(this.scope(eq(this.table.id, id)))
      .run();
  }

  /** Column values every insert carries — ShopScopedRepository adds the tenant here. */
  protected scopedValues(): Record<string, unknown> {
    return {};
  }

  private hasColumn(name: string): boolean {
    return name in this.table;
  }
}
