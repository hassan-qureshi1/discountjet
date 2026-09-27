import { eq } from 'drizzle-orm';
import { campaignDiscount } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type CampaignDiscountRow = typeof campaignDiscount.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type CampaignDiscountNew = Omit<typeof campaignDiscount.$inferInsert, 'shopId'>;

/** The contract handlers depend on — generic CRUD plus the campaign-scoped reads/writes below. */
export interface ICampaignDiscountRepository
  extends IShopScopedRepository<CampaignDiscountRow, CampaignDiscountNew> {
  listForCampaign(campaignId: string): Promise<CampaignDiscountRow[]>;
  setPublishResult(
    id: string,
    result: {
      shopifyGid: string | null;
      publishState: CampaignDiscountRow['publishState'];
      publishError: string | null;
    },
  ): Promise<void>;
  /**
   * Clears a campaign's whole discount set. `PUT /api/campaigns/:id` replaces
   * the set wholesale, and without this the route could only ever add rows.
   */
  deleteForCampaign(campaignId: string): Promise<void>;
}

/**
 * E8 campaign discounts — a discount the campaign authors, before and after
 * publish. Nothing here passes a shop id: it came in through the constructor
 * and `scope()` welds `shop_id = ?` onto every read and write.
 */
export class CampaignDiscountRepository
  extends ShopScopedRepository<typeof campaignDiscount>
  implements ICampaignDiscountRepository
{
  constructor(db: Db, shopId: string) {
    super(db, campaignDiscount, shopId);
  }

  async listForCampaign(campaignId: string): Promise<CampaignDiscountRow[]> {
    return this.db
      .select()
      .from(campaignDiscount)
      .where(this.scope(eq(campaignDiscount.campaignId, campaignId)))
      .all();
  }

  /**
   * Narrow update for the publish-transport bookkeeping done after each
   * Admin API write. The three columns move together — `shopifyGid` and
   * `publishError` are meaningless apart from the `publishState` they belong
   * to — so they are set through one method rather than an open-ended patch.
   */
  async setPublishResult(
    id: string,
    result: {
      shopifyGid: string | null;
      publishState: CampaignDiscountRow['publishState'];
      publishError: string | null;
    },
  ): Promise<void> {
    await this.db
      .update(campaignDiscount)
      .set(result)
      .where(this.scope(eq(campaignDiscount.id, id)));
  }

  async deleteForCampaign(campaignId: string): Promise<void> {
    await this.db
      .delete(campaignDiscount)
      .where(this.scope(eq(campaignDiscount.campaignId, campaignId)));
  }
}
