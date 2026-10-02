import { createDb, type Db } from '../db';
import { ShopRepository, type IShopRepository } from './ShopRepository';
import { BundleRepository, type IBundleRepository } from './BundleRepository';
import { BundleItemRepository, type IBundleItemRepository } from './BundleItemRepository';
import { DiscountRepository, type IDiscountRepository } from './DiscountRepository';
import { WebhookEventRepository, type IWebhookEventRepository } from './WebhookEventRepository';
import { TemplateRepository, type ITemplateRepository } from './TemplateRepository';
import { DueBundleScanner, type IDueBundleScanner } from './DueBundleScanner';
import { CampaignRepository, type ICampaignRepository } from './CampaignRepository';
import {
  CampaignDiscountRepository,
  type ICampaignDiscountRepository,
} from './CampaignDiscountRepository';
import {
  CampaignBundleRepository,
  type ICampaignBundleRepository,
} from './CampaignBundleRepository';

export { BaseRepository } from './BaseRepository';
export { ShopScopedRepository } from './ShopScopedRepository';
export { ShopRepository } from './ShopRepository';
export { BundleRepository } from './BundleRepository';
export { BundleItemRepository } from './BundleItemRepository';
export { DiscountRepository } from './DiscountRepository';
export { WebhookEventRepository } from './WebhookEventRepository';
export { TemplateRepository } from './TemplateRepository';
export { DueBundleScanner } from './DueBundleScanner';
export { CampaignRepository } from './CampaignRepository';
export { CampaignDiscountRepository } from './CampaignDiscountRepository';
export { CampaignBundleRepository } from './CampaignBundleRepository';
export { NotFoundError } from './types';

export type { IRepository, IShopScopedRepository, NewRow } from './types';
export type { Db, RepositoryTable } from './BaseRepository';
export type { ShopScopedTable } from './ShopScopedRepository';
export type {
  IShopRepository,
  ShopRow,
  ShopIdentity,
  ShopProfile,
  ShopProfileDto,
} from './ShopRepository';
export type { IBundleRepository, BundleRow, BundleNew } from './BundleRepository';
export type {
  IBundleItemRepository,
  BundleItemRow,
  BundleItemNew,
  BundleItemDraft,
} from './BundleItemRepository';
export type { IDiscountRepository, DiscountRow, DiscountNew } from './DiscountRepository';
export type {
  IWebhookEventRepository,
  WebhookEventRow,
  WebhookEventInsert,
} from './WebhookEventRepository';
export type { ITemplateRepository, TemplateRow, TemplateSeed } from './TemplateRepository';
export type { IDueBundleScanner, DueBundle } from './DueBundleScanner';
export type { ICampaignRepository, CampaignRow, CampaignNew } from './CampaignRepository';
export type {
  ICampaignDiscountRepository,
  CampaignDiscountRow,
  CampaignDiscountNew,
} from './CampaignDiscountRepository';
export type {
  ICampaignBundleRepository,
  CampaignBundleRow,
  CampaignBundleNew,
} from './CampaignBundleRepository';

/**
 * Every repository available to a request, already bound to the caller's shop.
 *
 * Typed as interfaces rather than concrete classes: handlers take this off the
 * context (`c.get('repos')`) and never construct a repository themselves, which
 * is what lets a test swap the whole set for in-memory fakes (see `inMemory.ts`)
 * without stubbing the Drizzle client.
 *
 * Add new repositories here.
 */
export interface Repositories {
  shops: IShopRepository;
  bundles: IBundleRepository;
  bundleItems: IBundleItemRepository;
  discounts: IDiscountRepository;
  events: IWebhookEventRepository;
  templates: ITemplateRepository;
  campaigns: ICampaignRepository;
  campaignDiscounts: ICampaignDiscountRepository;
  campaignBundles: ICampaignBundleRepository;
}

/**
 * For callers that do not have a shop id yet, or no Hono context at all: auth,
 * the install/uninstall lifecycle, and webhooks resolving a domain to a shop.
 */
export function createShopRepository(d1: D1Database): IShopRepository {
  return new ShopRepository(createDb(d1));
}

/** For the install lifecycle, which seeds templates with no request context. */
export function createTemplateRepository(d1: D1Database): ITemplateRepository {
  return new TemplateRepository(createDb(d1));
}

/**
 * For the scheduling cron only. Deliberately NOT part of `Repositories`: it is
 * unscoped, and nothing built per-request has any business holding it.
 */
export function createDueBundleScanner(d1: D1Database): IDueBundleScanner {
  return new DueBundleScanner(createDb(d1));
}

/**
 * Built once per authenticated request by the requireShop middleware. Cheap —
 * `createDb` is not a connection, and these are four small objects over the
 * same client.
 */
export function createRepositories(d1: D1Database, shopId: string): Repositories {
  return createRepositoriesFromDb(createDb(d1), shopId);
}

/**
 * Same set, for callers that already hold a Db — the discount sync runs from a
 * webhook with no request context and threads one through.
 */
export function createRepositoriesFromDb(db: Db, shopId: string): Repositories {
  return {
    shops: new ShopRepository(db),
    // Shop-scoped repositories take shopId, so they cannot be built unscoped:
    bundles: new BundleRepository(db, shopId),
    bundleItems: new BundleItemRepository(db, shopId),
    discounts: new DiscountRepository(db, shopId),
    events: new WebhookEventRepository(db),
    templates: new TemplateRepository(db),
    campaigns: new CampaignRepository(db, shopId),
    campaignDiscounts: new CampaignDiscountRepository(db, shopId),
    campaignBundles: new CampaignBundleRepository(db, shopId),
  };
}
