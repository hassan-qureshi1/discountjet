import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { webhookEvent } from '../schema';

export type WebhookEventRow = typeof webhookEvent.$inferSelect;
export type WebhookEventInsert = typeof webhookEvent.$inferInsert;

/** The contract handlers depend on — see `ShopStore` for why it exists. */
export interface WebhookEventStore {
  deliverySeen(deliveryId: string): Promise<boolean>;
  record(row: WebhookEventInsert): Promise<void>;
  list(shopId: string): Promise<Array<Pick<WebhookEventRow, 'topic' | 'receivedAt'>>>;
}

/**
 * The D1-backed `WebhookEventStore` — the idempotency + sync-health ledger.
 * `id` is Shopify's per-delivery `X-Shopify-Webhook-Id`, so a re-delivered
 * webhook is detected here rather than processed twice.
 */
export class WebhookEventRepository implements WebhookEventStore {
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
}
