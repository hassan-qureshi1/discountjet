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
import type {
  IBundleItemRepository,
  BundleItemRow,
  BundleItemNew,
  BundleItemDraft,
} from './BundleItemRepository';
import type { IDiscountRepository, DiscountRow, DiscountNew } from './DiscountRepository';
import type {
  IWebhookEventRepository,
  WebhookEventRow,
  WebhookEventInsert,
} from './WebhookEventRepository';
import type { ITemplateRepository, TemplateRow, TemplateSeed } from './TemplateRepository';
import type { DueBundle, IDueBundleScanner } from './DueBundleScanner';
import type { ICampaignRepository, CampaignRow, CampaignNew } from './CampaignRepository';
import type {
  ICampaignDiscountRepository,
  CampaignDiscountRow,
  CampaignDiscountNew,
} from './CampaignDiscountRepository';
import type {
  ICampaignBundleRepository,
  CampaignBundleRow,
  CampaignBundleNew,
} from './CampaignBundleRepository';

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
      metafieldState: 'NotYet',
      metafieldGid: null,
      scheduleStart: null,
      scheduleEnd: null,
      scheduleError: null,
      blockOnFailure: 0,
      campaignId: null,
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

export class InMemoryBundleItemRepository
  extends InMemoryBase<BundleItemRow, BundleItemNew>
  implements IBundleItemRepository
{
  protected readonly table = 'bundle_item';

  constructor(
    public readonly shopId: string,
    rows: BundleItemRow[] = [],
  ) {
    super(rows);
  }

  protected override inScope(row: BundleItemRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(data: NewRow<BundleItemNew>, id: string, now: string): BundleItemRow {
    return {
      priceAdjustment: null,
      titleOverride: null,
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as BundleItemRow;
  }

  /** Ordered by name, like the real repository's `findAll` override. */
  override async findAll(): Promise<BundleItemRow[]> {
    return this.rows
      .filter((r) => this.inScope(r))
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listForBundle(bundleId: string): Promise<BundleItemRow[]> {
    return this.rows
      .filter((r) => this.inScope(r) && r.bundleId === bundleId)
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async replaceForBundle(bundleId: string, items: BundleItemDraft[]): Promise<BundleItemRow[]> {
    const now = new Date().toISOString();
    this.rows = this.rows.filter((r) => !(this.inScope(r) && r.bundleId === bundleId));
    const created = items.map((item) => ({
      priceAdjustment: null,
      titleOverride: null,
      ...item,
      id: crypto.randomUUID(),
      shopId: this.shopId,
      bundleId,
      createdAt: now,
      updatedAt: now,
    }) as BundleItemRow);
    this.rows.push(...created);
    return created.map((r) => ({ ...r }));
  }

  async sumFor(bundleId: string): Promise<number | null> {
    const rows = await this.listForBundle(bundleId);
    if (rows.length === 0) return null;
    return rows.reduce((total, r) => total + r.price * r.qty, 0);
  }

  async sumsByBundle(): Promise<Map<string, number>> {
    const sums = new Map<string, number>();
    for (const r of this.rows) {
      if (!this.inScope(r)) continue;
      sums.set(r.bundleId, (sums.get(r.bundleId) ?? 0) + r.price * r.qty);
    }
    return sums;
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

export class InMemoryCampaignRepository
  extends InMemoryBase<CampaignRow, CampaignNew>
  implements ICampaignRepository
{
  protected readonly table = 'campaign';

  constructor(
    public readonly shopId: string,
    rows: CampaignRow[] = [],
  ) {
    super(rows);
  }

  protected override inScope(row: CampaignRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(data: NewRow<CampaignNew>, id: string, now: string): CampaignRow {
    return {
      description: null,
      startsAt: null,
      endsAt: null,
      publishedAt: null,
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as CampaignRow;
  }

  /** Newest first, and filtered by shop plus status — mirrors the real repository. */
  async listByStatus(status?: CampaignRow['status']): Promise<CampaignRow[]> {
    return this.rows
      .filter((r) => this.inScope(r) && (status === undefined || r.status === status))
      .map((r) => ({ ...r }))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
}

export class InMemoryCampaignDiscountRepository
  extends InMemoryBase<CampaignDiscountRow, CampaignDiscountNew>
  implements ICampaignDiscountRepository
{
  protected readonly table = 'campaign_discount';

  constructor(
    public readonly shopId: string,
    rows: CampaignDiscountRow[] = [],
  ) {
    super(rows);
  }

  protected override inScope(row: CampaignDiscountRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(
    data: NewRow<CampaignDiscountNew>,
    id: string,
    now: string,
  ): CampaignDiscountRow {
    return {
      code: null,
      shopifyGid: null,
      publishError: null,
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as CampaignDiscountRow;
  }

  async listForCampaign(campaignId: string): Promise<CampaignDiscountRow[]> {
    return this.rows
      .filter((r) => this.inScope(r) && r.campaignId === campaignId)
      .map((r) => ({ ...r }));
  }

  async setPublishResult(
    id: string,
    result: {
      shopifyGid: string | null;
      publishState: CampaignDiscountRow['publishState'];
      publishError: string | null;
    },
  ): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === id && this.inScope(r));
    if (i !== -1) this.rows[i] = { ...this.rows[i], ...result };
  }

  async deleteForCampaign(campaignId: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(this.inScope(r) && r.campaignId === campaignId));
  }
}

export class InMemoryCampaignBundleRepository
  extends InMemoryBase<CampaignBundleRow, CampaignBundleNew>
  implements ICampaignBundleRepository
{
  protected readonly table = 'campaign_bundle';

  constructor(
    public readonly shopId: string,
    rows: CampaignBundleRow[] = [],
  ) {
    super(rows);
  }

  protected override inScope(row: CampaignBundleRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(
    data: NewRow<CampaignBundleNew>,
    id: string,
    now: string,
  ): CampaignBundleRow {
    return {
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as CampaignBundleRow;
  }

  async listForCampaign(campaignId: string): Promise<CampaignBundleRow[]> {
    return this.rows
      .filter((r) => this.inScope(r) && r.campaignId === campaignId)
      .map((r) => ({ ...r }));
  }

  async deleteForCampaign(campaignId: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(this.inScope(r) && r.campaignId === campaignId));
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

/**
 * The in-memory twin of `TemplateRepository` — unscoped, like the real thing,
 * and filtering `active === 1` in both reads to match the real queries.
 */
export class InMemoryTemplateRepository implements ITemplateRepository {
  constructor(public rows: TemplateRow[] = []) {}

  async listActive(): Promise<TemplateRow[]> {
    return this.rows
      .filter((r) => r.active === 1)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((r) => ({ ...r }));
  }

  async findBySlug(slug: string): Promise<TemplateRow | null> {
    const row = this.rows.find((r) => r.slug === slug && r.active === 1);
    return row ? { ...row } : null;
  }

  async upsertMany(seeds: TemplateSeed[]): Promise<void> {
    const now = new Date().toISOString();
    for (const seed of seeds) {
      const i = this.rows.findIndex((r) => r.slug === seed.slug);
      if (i === -1) {
        this.rows.push({
          id: crypto.randomUUID(),
          slug: seed.slug,
          name: seed.name,
          description: seed.description,
          example: seed.example ?? null,
          category: seed.category,
          symbol: seed.symbol ?? null,
          type: seed.type,
          defaults: seed.defaults,
          sortOrder: seed.sortOrder,
          active: seed.active ?? 1,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        this.rows[i] = {
          ...this.rows[i],
          name: seed.name,
          description: seed.description,
          example: seed.example ?? null,
          category: seed.category,
          symbol: seed.symbol ?? null,
          type: seed.type,
          defaults: seed.defaults,
          sortOrder: seed.sortOrder,
          active: seed.active ?? 1,
          updatedAt: now,
        };
      }
    }
  }
}

/**
 * The in-memory twin of `DueBundleScanner`, for the cron's lifecycle tests.
 * Mirrors the real predicates — including that it returns ids only.
 */
export class InMemoryDueBundleScanner implements IDueBundleScanner {
  constructor(private readonly rows: BundleRow[]) {}

  async findDue(now: string): Promise<DueBundle[]> {
    const due: DueBundle[] = [];
    for (const r of this.rows) {
      if (r.status === 'Scheduled' && r.scheduleStart !== null && r.scheduleStart <= now) {
        due.push({ shopId: r.shopId, bundleId: r.id, to: 'Active' });
      } else if (r.status === 'Active' && r.scheduleEnd !== null && r.scheduleEnd <= now) {
        due.push({ shopId: r.shopId, bundleId: r.id, to: 'Ended' });
      }
    }
    return due;
  }
}

/** The concrete fakes, so a test can seed and then read them back. */
export interface InMemoryRepositories extends Repositories {
  shops: InMemoryShopRepository;
  bundles: InMemoryBundleRepository;
  bundleItems: InMemoryBundleItemRepository;
  discounts: InMemoryDiscountRepository;
  events: InMemoryWebhookEventRepository;
  templates: InMemoryTemplateRepository;
  campaigns: InMemoryCampaignRepository;
  campaignDiscounts: InMemoryCampaignDiscountRepository;
  campaignBundles: InMemoryCampaignBundleRepository;
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
    bundleItems?: BundleItemRow[];
    discounts?: DiscountRow[];
    events?: WebhookEventRow[];
    templates?: TemplateRow[];
    campaigns?: CampaignRow[];
    campaignDiscounts?: CampaignDiscountRow[];
    campaignBundles?: CampaignBundleRow[];
  } = {},
): InMemoryRepositories {
  return {
    shops: new InMemoryShopRepository(seed.shops ?? []),
    bundles: new InMemoryBundleRepository(shopId, seed.bundles ?? []),
    bundleItems: new InMemoryBundleItemRepository(shopId, seed.bundleItems ?? []),
    discounts: new InMemoryDiscountRepository(shopId, seed.discounts ?? []),
    events: new InMemoryWebhookEventRepository(seed.events ?? []),
    templates: new InMemoryTemplateRepository(seed.templates ?? []),
    campaigns: new InMemoryCampaignRepository(shopId, seed.campaigns ?? []),
    campaignDiscounts: new InMemoryCampaignDiscountRepository(shopId, seed.campaignDiscounts ?? []),
    campaignBundles: new InMemoryCampaignBundleRepository(shopId, seed.campaignBundles ?? []),
  };
}
