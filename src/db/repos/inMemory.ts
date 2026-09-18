// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementations of the store interfaces. TEST-ONLY — nothing in
// the Worker imports this file, so it ships in no bundle.
//
// Why these exist: tests used to stub the Drizzle client, which meant asserting
// on how many times a handler called `createDb` and in what order. Those
// assertions broke whenever a handler was refactored, even when its behaviour
// was identical. A test now seeds real rows here and asserts on the resulting
// state ("after this PUT the stored row is `Written`") instead.
//
// `implements` is doing real work: if a store interface gains a method, this
// file stops compiling until the fake gains it too, so a fake can never
// silently drift from the contract handlers depend on.
// ─────────────────────────────────────────────────────────────────────────────

import type { Repos } from './index';
import type { ShopRow, ShopIdentity, ShopProfile, ShopProfileDto, ShopStore } from './shopRepo';
import type { BundleRow, BundleStore } from './bundleRepo';
import type { DiscountRow, DiscountInsert, DiscountStore } from './discountRepo';
import type { WebhookEventRow, WebhookEventInsert, WebhookEventStore } from './webhookEventRepo';

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

export class InMemoryShopStore implements ShopStore {
  constructor(public rows: ShopRow[] = []) {}

  async findInstalledByDomain(myshopifyDomain: string): Promise<ShopIdentity | null> {
    const row = this.rows.find(
      (r) => r.myshopifyDomain === myshopifyDomain && r.status === 'installed',
    );
    return row ? { id: row.id, myshopifyDomain: row.myshopifyDomain } : null;
  }

  async findIdByDomain(myshopifyDomain: string): Promise<string | null> {
    return this.rows.find((r) => r.myshopifyDomain === myshopifyDomain)?.id ?? null;
  }

  async findById(shopId: string): Promise<ShopRow | null> {
    return this.rows.find((r) => r.id === shopId) ?? null;
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

export class InMemoryBundleStore implements BundleStore {
  constructor(public rows: BundleRow[] = []) {}

  /** Mirrors the repository's tenant scoping — an id alone never matches. */
  private index(shopId: string, id: string): number {
    return this.rows.findIndex((r) => r.id === id && r.shopId === shopId);
  }

  async list(shopId: string): Promise<BundleRow[]> {
    return this.rows.filter((r) => r.shopId === shopId);
  }

  async find(shopId: string, id: string): Promise<BundleRow | null> {
    const i = this.index(shopId, id);
    return i === -1 ? null : { ...this.rows[i] };
  }

  async insert(row: BundleRow): Promise<void> {
    this.rows.push({ ...row });
  }

  async update(shopId: string, id: string, patch: Partial<BundleRow>): Promise<void> {
    const i = this.index(shopId, id);
    if (i !== -1) this.rows[i] = { ...this.rows[i], ...patch };
  }

  async setMetafieldState(
    shopId: string,
    id: string,
    state: BundleRow['metafieldState'],
    metafieldGid: string | null,
  ): Promise<void> {
    await this.update(shopId, id, { metafieldState: state, metafieldGid });
  }

  async delete(shopId: string, id: string): Promise<void> {
    const i = this.index(shopId, id);
    if (i !== -1) this.rows.splice(i, 1);
  }
}

export class InMemoryDiscountStore implements DiscountStore {
  constructor(public rows: DiscountRow[] = []) {}

  async listLive(shopId: string): Promise<DiscountRow[]> {
    return this.rows.filter((r) => r.shopId === shopId && r.deletedAt === null);
  }

  async find(shopId: string, id: string): Promise<DiscountRow | null> {
    return this.rows.find((r) => r.id === id && r.shopId === shopId) ?? null;
  }

  async findVersionByGid(
    shopId: string,
    shopifyGid: string,
  ): Promise<{ id: string; updatedAt: string | null } | null> {
    const row = this.rows.find((r) => r.shopId === shopId && r.shopifyGid === shopifyGid);
    return row ? { id: row.id, updatedAt: row.updatedAt } : null;
  }

  async insert(row: DiscountInsert): Promise<void> {
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
    } as DiscountRow);
  }

  async updateById(id: string, patch: Partial<DiscountRow>): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i !== -1) this.rows[i] = { ...this.rows[i], ...patch };
  }

  async tombstoneByGid(shopId: string, shopifyGid: string, deletedAt: string): Promise<void> {
    for (const row of this.rows) {
      if (row.shopId === shopId && row.shopifyGid === shopifyGid) row.deletedAt = deletedAt;
    }
  }

  async listLiveGids(shopId: string): Promise<string[]> {
    return (await this.listLive(shopId)).map((r) => r.shopifyGid);
  }

  async countUnknownType(shopId: string): Promise<number> {
    return (await this.listLive(shopId)).filter((r) => r.type === null).length;
  }
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
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
export interface InMemoryRepos extends Repos {
  shops: InMemoryShopStore;
  bundles: InMemoryBundleStore;
  discounts: InMemoryDiscountStore;
  events: InMemoryWebhookEventStore;
}

/** Builds a fake `Repos` seeded with the given rows. */
export function createInMemoryRepos(seed: {
  shops?: ShopRow[];
  bundles?: BundleRow[];
  discounts?: DiscountRow[];
  events?: WebhookEventRow[];
} = {}): InMemoryRepos {
  return {
    shops: new InMemoryShopStore(seed.shops ?? []),
    bundles: new InMemoryBundleStore(seed.bundles ?? []),
    discounts: new InMemoryDiscountStore(seed.discounts ?? []),
    events: new InMemoryWebhookEventStore(seed.events ?? []),
  };
}
