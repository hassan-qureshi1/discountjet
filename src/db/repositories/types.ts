// Storage-agnostic contracts for the repository layer. Deliberately free of
// Drizzle types so tests (and any future backing store) can satisfy them —
// `inMemory.ts` implements these without importing Drizzle at all.

/**
 * What a caller supplies to create(): the repository mints `id` and the
 * timestamps, so passing them is not just unnecessary, it is a type error.
 * An explicit id is still allowed for rows whose id comes from Shopify.
 */
export type NewRow<TNew> = Omit<TNew, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export interface IRepository<TRow, TNew> {
  /** The row may legitimately be absent — callers map null to a 404. */
  findById(id: string): Promise<TRow | null>;
  /** Absence means corrupt state — throws NotFoundError. */
  getById(id: string): Promise<TRow>;
  findAll(): Promise<TRow[]>;
  create(data: NewRow<TNew>): Promise<TRow>;
  update(id: string, patch: Partial<TNew>): Promise<TRow>;
  delete(id: string): Promise<void>;
}

/**
 * A repository bound to one tenant. The `shopId` is readonly and set at
 * construction — see `ShopScopedRepository` for why that is the whole point.
 */
export interface IShopScopedRepository<TRow, TNew> extends IRepository<TRow, TNew> {
  readonly shopId: string;
}

export class NotFoundError extends Error {
  constructor(
    public readonly table: string,
    public readonly id: string,
  ) {
    super(`No row in ${table} with id ${id}`);
    this.name = 'NotFoundError';
  }
}
