import { and, desc, eq } from 'drizzle-orm';
import { campaign } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type CampaignRow = typeof campaign.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type CampaignNew = Omit<typeof campaign.$inferInsert, 'shopId'>;

/** The contract handlers depend on — generic CRUD plus the one narrow read below. */
export interface ICampaignRepository extends IShopScopedRepository<CampaignRow, CampaignNew> {
  listByStatus(status?: CampaignRow['status']): Promise<CampaignRow[]>;
  claimForPublish(id: string): Promise<CampaignRow | null>;
}

/**
 * E8 campaigns. Nothing here passes a shop id: it came in through the
 * constructor and `scope()` welds `shop_id = ?` onto every read and write, so
 * another shop's campaign reads as absent rather than being mutated.
 */
export class CampaignRepository
  extends ShopScopedRepository<typeof campaign>
  implements ICampaignRepository
{
  constructor(db: Db, shopId: string) {
    super(db, campaign, shopId);
  }

  /** Newest first — the list page's default order, and what a merchant expects
   *  when they have just created one. */
  async listByStatus(status?: CampaignRow['status']): Promise<CampaignRow[]> {
    const where = status ? this.scope(eq(campaign.status, status)) : this.scope();
    return this.db.select().from(campaign).where(where).orderBy(desc(campaign.createdAt)).all();
  }

  /**
   * Compare-and-set: moves this campaign out of `Draft` and returns the row it
   * won, or null when it was not `Draft` any more.
   *
   * Publish reads the status and then writes it back only after every Shopify
   * round-trip, so a plain read-then-write lets two concurrent handlers (two
   * tabs, a browser retry, a proxy retry) both see `Draft` and both create the
   * full set of discounts. A single conditional UPDATE is atomic in D1, so the
   * claim IS the gate: the loser gets null and 409s having touched nothing.
   *
   * `Scheduled` is the claim state rather than a new enum value — the publish
   * route corrects it to the derived status at the end, and its
   * revert-to-`Draft` path releases the claim when nothing went live.
   */
  async claimForPublish(id: string): Promise<CampaignRow | null> {
    const row = await this.db
      .update(campaign)
      .set({ status: 'Scheduled', updatedAt: new Date().toISOString() })
      .where(this.scope(and(eq(campaign.id, id), eq(campaign.status, 'Draft'))))
      .returning()
      .get();
    return (row as CampaignRow | undefined) ?? null;
  }
}
