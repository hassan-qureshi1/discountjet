// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementations of the repository interfaces. TEST-ONLY — nothing
// in the Worker imports this file, so it ships in no bundle.
//
// Why these exist: tests used to stub the Drizzle client, which meant asserting
// on how many times a handler called `createDb` and in what order. Those
// assertions broke whenever a handler was refactored, even when its behaviour
// was identical. A test now seeds real rows here and asserts on the resulting
// state ("after this PUT the stored row is `Written`") instead.
//
// `implements` is doing real work: if an interface gains a method, this file
// stops compiling until the fake gains it too, so a fake can never silently
// drift from the contract handlers depend on.
//
// These fakes prove BEHAVIOUR. They do not prove that the real repositories
// emit `where shop_id = ?` — that is what the recording fake D1 in
// `testing/fakeD1.ts` is for. The two are complementary, not alternatives.
//
// INVARIANT: every read returns a COPY of the stored row(s). Handing out the
// stored object would let a handler mutate the store just by touching what it
// read — something D1 can never do — so the fake would mask a bug rather than
// expose it. Writes go through the repository's own methods, never through a
// row a caller is holding.
// ─────────────────────────────────────────────────────────────────────────────

import type { Repositories } from './index';
import { NotFoundError, type IRepository, type NewRow } from './types';
import type {
  IShopRepository,
  ShopRow,
  ShopIdentity,
  ShopProfile,
  ShopProfileDto,
} from './ShopRepository';
import type { ShopInsert } from './ShopRepository';
import type { IBundleRepository, BundleRow, BundleNew } from './BundleRepository';
import type { IDiscountRepository, DiscountRow, DiscountNew } from './DiscountRepository';
import type {
  IWebhookEventRepository,
  WebhookEventRow,
  WebhookEventInsert,
} from './WebhookEventRepository';

/**
 * The generic half of every fake, mirroring `BaseRepository`: id and timestamp
 * minting on create, NotFoundError on a missing update, and a `inScope` hook
 * that the shop-scoped fakes override — the same seam `scope()` provides on the
 * real thing.
 */
abstract class InMemoryBase<TRow extends { id: string }, TNew> implements IRepository<TRow, TNew> {
  constructor(public rows: TRow[] = []) {}

  protected abstract readonly table: string;
  /** Builds a complete row from a partial create payload. */
  protected abstract materialize(data: NewRow<TNew>, id: string, now: string): TRow;

  /** Tenant filter. The scoped fakes override this; the shop fake does not. */
  protected inScope(_row: TRow): boolean {
    return true;
  }

  /** Whether `update()` stamps `updatedAt`, matching the real base repository. */
  protected readonly stampsUpdatedAt: boolean = true;

  private indexOf(id: string): number {
    return this.rows.findIndex((r) => r.id === id && this.inScope(r));
  }

  async findById(id: string): Promise<TRow | null> {
    const i = this.indexOf(id);
    return i === -1 ? null : { ...this.rows[i] };
  }

  async getById(id: string): Promise<TRow> {
    const row = await this.findById(id);
    if (!row) throw new NotFoundError(this.table, id);
    return row;
  }

  async findAll(): Promise<TRow[]> {
    return this.rows.filter((r) => this.inScope(r)).map((r) => ({ ...r }));
  }

  async create(data: NewRow<TNew>): Promise<TRow> {
    const row = this.materialize(data, data.id ?? crypto.randomUUID(), new Date().toISOString());
    this.rows.push(row);
    return { ...row };
  }

  async update(id: string, patch: Partial<TNew>): Promise<TRow> {
    const i = this.indexOf(id);
    if (i === -1) throw new NotFoundError(this.table, id);
    const stamp = this.stampsUpdatedAt ? { updatedAt: new Date().toISOString() } : {};
    this.rows[i] = { ...this.rows[i], ...patch, ...stamp };
    return { ...this.rows[i] };
  }

  async delete(id: string): Promise<void> {
    const i = this.indexOf(id);
    if (i !== -1) this.rows.splice(i, 1);
  }
}

/** A shop row with everything nullable defaulted — seeds stay short. */
export function shopRow(overrides: Partial<ShopRow> & { id: string }): ShopRow {
  return {
    installDate: null,
    plan: null,
    myshopifyDomain: null,
    domain: null,
    name: null,
    email: null,
    shopOwner: null,
    city: null,
    countryName: null,
    currency: null,
    ianaTimezone: null,
    primaryLocale: null,
    status: 'installed',
    shopifyPlus: null,
    partnerDevelopment: null,
    planName: null,
    cartTransformGid: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

export class InMemoryShopRepository
  extends InMemoryBase<ShopRow, ShopInsert>
  implements IShopRepository
{
  protected readonly table = 'shopify_shop';

  protected materialize(data: NewRow<ShopInsert>, id: string, now: string): ShopRow {
    return shopRow({ ...data, id, createdAt: now, updatedAt: now });
  }

  async findInstalledByDomain(myshopifyDomain: string): Promise<ShopIdentity | null> {
    const row = this.rows.find(
      (r) => r.myshopifyDomain === myshopifyDomain && r.status === 'installed',
    );
    return row ? { id: row.id, myshopifyDomain: row.myshopifyDomain } : null;
  }

  async findIdByDomain(myshopifyDomain: string): Promise<string | null> {
    return this.rows.find((r) => r.myshopifyDomain === myshopifyDomain)?.id ?? null;
  }

  async findProfile(shopId: string): Promise<ShopProfileDto | null> {
    const r = await this.findById(shopId);
    if (!r) return null;
    return {
      name: r.name,
      domain: r.domain,
      myshopifyDomain: r.myshopifyDomain,
      plan: r.plan,
      owner: r.shopOwner,
      email: r.email,
      country: r.countryName,
      currency: r.currency,
      installedAt: r.installDate,
      status: r.status,
    };
  }

  async upsertInstalled(row: {
    id: string;
    myshopifyDomain: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    const existing = this.rows.find((r) => r.id === row.id);
    if (existing) {
      existing.status = 'installed';
      existing.updatedAt = row.updatedAt;
      return;
    }
    this.rows.push(
      shopRow({
        id: row.id,
        myshopifyDomain: row.myshopifyDomain,
        status: 'installed',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    );
  }

  async markInstalled(myshopifyDomain: string, profile: ShopProfile, now: string): Promise<void> {
    const row = this.rows.find((r) => r.myshopifyDomain === myshopifyDomain);
    if (!row) return;
    Object.assign(row, profile, { installDate: now, status: 'installed', updatedAt: now });
  }

  async markUninstalled(myshopifyDomain: string, now: string): Promise<void> {
    const row = this.rows.find((r) => r.myshopifyDomain === myshopifyDomain);
    if (!row) return;
    row.status = 'uninstalled';
    row.updatedAt = now;
  }

  async updatePlanCache(
    shopId: string,
    plan: { shopifyPlus: boolean; partnerDevelopment: boolean; planName: string },
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === shopId);
    if (!row) return;
    row.shopifyPlus = plan.shopifyPlus ? 1 : 0;
    row.partnerDevelopment = plan.partnerDevelopment ? 1 : 0;
    row.planName = plan.planName;
  }

  async setCartTransformGid(shopId: string, gid: string): Promise<void> {
    const row = this.rows.find((r) => r.id === shopId);
    if (row) row.cartTransformGid = gid;
  }
}

export class InMemoryBundleRepository
  extends InMemoryBase<BundleRow, BundleNew>
  implements IBundleRepository
{
  protected readonly table = 'bundle';

  constructor(
    public readonly shopId: string,
    rows: BundleRow[] = [],
  ) {
    super(rows);
  }

  /** Mirrors the repository's tenant scoping — an id alone never matches. */
  protected override inScope(row: BundleRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(data: NewRow<BundleNew>, id: string, now: string): BundleRow {
    return {
      parentVariantId: null,
      price: null,
      sumOfItems: null,
      metafieldState: 'NotYet',
      metafieldGid: null,
      scheduleStart: null,
      scheduleEnd: null,
      blockOnFailure: 0,
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as BundleRow;
  }

  async setMetafieldState(
    id: string,
    state: BundleRow['metafieldState'],
    metafieldGid: string | null,
  ): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === id && this.inScope(r));
    // Deliberately not `update()` — the real repository does not bump
    // `updatedAt` for transport bookkeeping either.
    if (i !== -1) this.rows[i] = { ...this.rows[i], metafieldState: state, metafieldGid };
  }
}

export class InMemoryDiscountRepository
  extends InMemoryBase<DiscountRow, DiscountNew>
  implements IDiscountRepository
{
  protected readonly table = 'discount';

  constructor(
    public readonly shopId: string,
    rows: DiscountRow[] = [],
  ) {
    super(rows);
  }

  protected override inScope(row: DiscountRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(data: NewRow<DiscountNew>, id: string, now: string): DiscountRow {
    return {
      type: null,
      method: null,
      status: null,
      products: 0,
      campaignId: null,
      deletedAt: null,
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as DiscountRow;
  }

  async listLive(): Promise<DiscountRow[]> {
    return this.rows.filter((r) => this.inScope(r) && r.deletedAt === null).map((r) => ({ ...r }));
  }

  async findVersionByGid(
    shopifyGid: string,
  ): Promise<{ id: string; updatedAt: string | null } | null> {
    const row = this.rows.find((r) => this.inScope(r) && r.shopifyGid === shopifyGid);
    return row ? { id: row.id, updatedAt: row.updatedAt } : null;
  }

  /** Verbatim insert, Shopify's timestamps kept — see the real `insertMirror`. */
  async insertMirror(row: DiscountNew): Promise<void> {
    this.rows.push({
      type: null,
      method: null,
      status: null,
      products: 0,
      campaignId: null,
      deletedAt: null,
      createdAt: null,
      updatedAt: null,
      ...row,
      shopId: this.shopId,
    } as DiscountRow);
  }

  /** Verbatim patch, no `updatedAt` stamp — see the real `updateMirror`. */
  async updateMirror(id: string, patch: Partial<DiscountNew>): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === id && this.inScope(r));
    if (i !== -1) this.rows[i] = { ...this.rows[i], ...patch };
  }

  async tombstoneByGid(shopifyGid: string, deletedAt: string): Promise<void> {
    for (const row of this.rows) {
      if (this.inScope(row) && row.shopifyGid === shopifyGid) row.deletedAt = deletedAt;
    }
  }

  async listLiveGids(): Promise<string[]> {
    return (await this.listLive()).map((r) => r.shopifyGid);
  }

  async countUnknownType(): Promise<number> {
    return (await this.listLive()).filter((r) => r.type === null).length;
  }
}

/** Outside the generic base, exactly as the real one is — see its class comment. */
export class InMemoryWebhookEventRepository implements IWebhookEventRepository {
  constructor(public rows: WebhookEventRow[] = []) {}

  async deliverySeen(deliveryId: string): Promise<boolean> {
    return this.rows.some((r) => r.id === deliveryId);
  }

  async record(row: WebhookEventInsert): Promise<void> {
    this.rows.push({ shopId: null, shopifyGid: null, ...row } as WebhookEventRow);
  }

  async list(shopId: string): Promise<Array<Pick<WebhookEventRow, 'topic' | 'receivedAt'>>> {
    return this.rows
      .filter((r) => r.shopId === shopId)
      .map((r) => ({ topic: r.topic, receivedAt: r.receivedAt }));
  }
}

/** The concrete fakes, so a test can seed and then read them back. */
export interface InMemoryRepositories extends Repositories {
  shops: InMemoryShopRepository;
  bundles: InMemoryBundleRepository;
  discounts: InMemoryDiscountRepository;
  events: InMemoryWebhookEventRepository;
}

/**
 * Builds a fake `Repositories` bound to `shopId` — the same argument the real
 * `createRepositories` takes, so a test cannot accidentally build an unscoped set.
 */
export function createInMemoryRepositories(
  shopId: string,
  seed: {
    shops?: ShopRow[];
    bundles?: BundleRow[];
    discounts?: DiscountRow[];
    events?: WebhookEventRow[];
  } = {},
): InMemoryRepositories {
  return {
    shops: new InMemoryShopRepository(seed.shops ?? []),
    bundles: new InMemoryBundleRepository(shopId, seed.bundles ?? []),
    discounts: new InMemoryDiscountRepository(shopId, seed.discounts ?? []),
    events: new InMemoryWebhookEventRepository(seed.events ?? []),
  };
}
