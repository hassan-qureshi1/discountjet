import { desc, eq } from 'drizzle-orm';
import type { Db } from './BaseRepository';
import { webhookEvent } from '../schema';

export type WebhookEventRow = typeof webhookEvent.$inferSelect;
export type WebhookEventInsert = typeof webhookEvent.$inferInsert;

/** The contract handlers and the sync module depend on. */
export interface IWebhookEventRepository {
  deliverySeen(deliveryId: string): Promise<boolean>;
  record(row: WebhookEventInsert): Promise<void>;
  list(shopId: string): Promise<Array<Pick<WebhookEventRow, 'topic' | 'receivedAt'>>>;
  listRecent(shopId: string, limit: number): Promise<WebhookEventRow[]>;
}

/**
 * The idempotency + sync-health ledger.
 *
 * DELIBERATELY OUTSIDE the BaseRepository/ShopScopedRepository hierarchy, and
 * the one place in the app that still takes a `shopId` as an argument. Three
 * reasons, all properties of what this table is:
 *
 *  - `shop_id` is nullable with no FK, so the ledger survives a shop deletion
 *    rather than cascading with it. A ShopScopedRepository asserts the opposite.
 *  - `deliverySeen()` gates on the delivery id ALONE. Scoping it by shop would
 *    be wrong as well as pointless: `X-Shopify-Webhook-Id` is globally unique,
 *    and the gate has to fire before we have resolved a shop at all.
 *  - `id` is Shopify's delivery id, not a minted UUID, so `create()`'s id and
 *    timestamp minting has nothing to do here.
 *
 * Adding generic CRUD to this table would advertise guarantees it does not have.
 */
export class WebhookEventRepository implements IWebhookEventRepository {
  constructor(private readonly db: Db) {}

  /** True when this delivery id has been seen before — the idempotency gate. */
  async deliverySeen(deliveryId: string): Promise<boolean> {
    const row = await this.db
      .select({ id: webhookEvent.id })
      .from(webhookEvent)
      .where(eq(webhookEvent.id, deliveryId))
      .get();
    return row !== undefined && row !== null;
  }

  async record(row: WebhookEventInsert): Promise<void> {
    await this.db.insert(webhookEvent).values(row);
  }

  /** The shop's event ledger, used to derive the sync-health timestamps. */
  async list(shopId: string): Promise<Array<Pick<WebhookEventRow, 'topic' | 'receivedAt'>>> {
    return this.db
      .select({ topic: webhookEvent.topic, receivedAt: webhookEvent.receivedAt })
      .from(webhookEvent)
      .where(eq(webhookEvent.shopId, shopId))
      .all();
  }

  /**
   * The newest events for a shop, for the dashboard's activity feed.
   *
   * Returns whole rows because the feed needs `shopifyGid` to name the
   * discount an event was about, which `list()` deliberately does not carry.
   */
  async listRecent(shopId: string, limit: number): Promise<WebhookEventRow[]> {
    return this.db
      .select()
      .from(webhookEvent)
      .where(eq(webhookEvent.shopId, shopId))
      .orderBy(desc(webhookEvent.receivedAt))
      .limit(limit)
      .all();
  }
}
