import { eq } from 'drizzle-orm';
import { campaignBundle } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type CampaignBundleRow = typeof campaignBundle.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type CampaignBundleNew = Omit<typeof campaignBundle.$inferInsert, 'shopId'>;

/** The contract handlers depend on — generic CRUD plus the campaign-scoped reads/writes below. */
export interface ICampaignBundleRepository
  extends IShopScopedRepository<CampaignBundleRow, CampaignBundleNew> {
  listForCampaign(campaignId: string): Promise<CampaignBundleRow[]>;
  deleteForCampaign(campaignId: string): Promise<void>;
  listCampaignIdsForBundle(bundleId: string): Promise<string[]>;
}

/**
 * E8 campaign bundles — a reference to an existing E6 bundle. No config is
 * authored here; the bundle owns its own definition, the campaign only owns
 * its schedule while live. Nothing here passes a shop id: it came in through
 * the constructor and `scope()` welds `shop_id = ?` onto every read and write.
 */
export class CampaignBundleRepository
  extends ShopScopedRepository<typeof campaignBundle>
  implements ICampaignBundleRepository
{
  constructor(db: Db, shopId: string) {
    super(db, campaignBundle, shopId);
  }

  async listForCampaign(campaignId: string): Promise<CampaignBundleRow[]> {
    return this.db
      .select()
      .from(campaignBundle)
      .where(this.scope(eq(campaignBundle.campaignId, campaignId)))
      .all();
  }

  /** Clears a campaign's whole bundle set — `PUT /api/campaigns/:id` replaces it wholesale. */
  async deleteForCampaign(campaignId: string): Promise<void> {
    await this.db
      .delete(campaignBundle)
      .where(this.scope(eq(campaignBundle.campaignId, campaignId)));
  }

  /**
   * Which campaigns hold this bundle, by id.
   *
   * Asked by two callers for the same reason — the publish-time overlap check
   * and the cron's ownership resolution both need to know who else wants this
   * bundle — so it exists once rather than as two similar queries.
   */
  async listCampaignIdsForBundle(bundleId: string): Promise<string[]> {
    const rows = await this.db
      .select({ campaignId: campaignBundle.campaignId })
      .from(campaignBundle)
      .where(this.scope(eq(campaignBundle.bundleId, bundleId)))
      .all();
    return rows.map((r) => r.campaignId);
  }
}
