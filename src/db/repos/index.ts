import type { Db } from '../db';
import { ShopRepository, type ShopStore } from './shopRepo';
import { BundleRepository, type BundleStore } from './bundleRepo';
import { DiscountRepository, type DiscountStore } from './discountRepo';
import { WebhookEventRepository, type WebhookEventStore } from './webhookEventRepo';

/**
 * Every store a request can reach, as interfaces rather than concrete classes.
 * Handlers take this off the context (`c.get('repos')`) and never construct a
 * repository themselves — which is what lets a test swap the whole set for
 * in-memory fakes (see `inMemory.ts`) without stubbing the Drizzle client.
 */
export interface Repos {
  shops: ShopStore;
  bundles: BundleStore;
  discounts: DiscountStore;
  events: WebhookEventStore;
}

/**
 * Builds the D1-backed set for one request. Cheap — `createDb` is not a
 * connection, and these are four small objects over the same client.
 */
export function createRepos(db: Db): Repos {
  return {
    shops: new ShopRepository(db),
    bundles: new BundleRepository(db),
    discounts: new DiscountRepository(db),
    events: new WebhookEventRepository(db),
  };
}

export type { ShopStore, BundleStore, DiscountStore, WebhookEventStore };
