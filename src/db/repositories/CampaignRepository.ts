import { desc, eq } from 'drizzle-orm';
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
}
