import { and, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { bundle, campaign, campaignBundle } from '../schema';
import type { Db } from './BaseRepository';

/** A bundle whose window has crossed a boundary, and which way it crossed. */
export interface DueBundle {
  shopId: string;
  bundleId: string;
  /**
   * ADVISORY. The scan that found the row, not a decision. The cron re-derives
   * the real target with `deriveStatus` once the row is loaded through a scoped
   * repository — which is what stops a window entirely in the past (Scheduled,
   * start passed, end also passed) from being activated for one pass before the
   * next pass ends it.
   */
  to: 'Active' | 'Ended';
}

export interface IDueBundleScanner {
  findDue(now: string): Promise<DueBundle[]>;
}

/**
 * The scheduling cron's due-scan.
 *
 * DELIBERATELY UNSCOPED, and the only unscoped access to `bundle` in the app.
 * The cron has no tenant — it runs for every shop at once — and the alternative
 * (loop every installed shop, build scoped repositories, query each) costs one
 * D1 round-trip per install every five minutes, almost all returning nothing,
 * scaling with installs rather than with work.
 *
 * The exception is kept narrow in the only way that matters: this class reads
 * IDENTIFIERS ONLY. It never selects a name, a price, an item, or a metafield
 * GID, and it has no write path. That holds for the campaign tables the
 * handover scan joins as well: they are joined to FILTER bundle ids, and
 * nothing about a campaign is selected. Everything the cron then does with these ids
 * goes back through `createRepositories(env.DB, shopId)`, which re-reads the row
 * under `where shop_id = ?` — so a bug here surfaces as a row that reads as
 * absent, not as a cross-tenant write.
 *
 * The two window queries are served by `bundle_due_start_idx` /
 * `bundle_due_end_idx`, which are status-leading rather than shop-leading for
 * exactly this reason. The handover scan drives off `campaign_bundle`'s
 * primary/unique keys and the campaign row's own id.
 */
export class DueBundleScanner implements IDueBundleScanner {
  constructor(private readonly db: Db) {}

  /**
   * `now` is a parameter rather than read inside, so tests drive the clock
   * instead of mocking `Date`.
   *
   * Separate queries rather than one `UNION ALL`: identical index usage, and
   * the result needs a per-branch tag anyway. Four of them now — two windows,
   * the handover, and the capture sweep — de-duplicated into one list.
   */
  async findDue(now: string): Promise<DueBundle[]> {
    const ids = { shopId: bundle.shopId, bundleId: bundle.id };

    const activating = await this.db
      .select(ids)
      .from(bundle)
      .where(
        and(
          eq(bundle.status, 'Scheduled'),
          isNotNull(bundle.scheduleStart),
          lte(bundle.scheduleStart, now),
        ),
      )
      .all();

    const deactivating = await this.db
      .select(ids)
      .from(bundle)
      .where(
        and(
          eq(bundle.status, 'Active'),
          isNotNull(bundle.scheduleEnd),
          lte(bundle.scheduleEnd, now),
        ),
      )
      .all();

    // THE HANDOVER SCAN. A bundle whose HOLDING CAMPAIGN's window contains
    // `now` while the bundle itself names a different owner — or none.
    //
    // Ownership is derived per pass rather than stamped at publish, so publish
    // writes NOTHING to a bundle whose campaign starts later. The row is left
    // exactly as the merchant had it: no window, no owner, and typically
    // `Draft`. That matches none of the three queries above, so without this
    // one the cron never loads it and `resolveCurrentOwner` never runs — a
    // campaign scheduled for December would quietly never happen, and so would
    // every sequential campaign separated by a gap (the first ends, its row is
    // written `Ended` on a past window with its capture already back, and
    // nothing is due about it again).
    //
    // Reached through the campaign rather than the bundle, because the bundle
    // row is precisely the thing that has not been written yet. The conditions
    // are the ones `resolveCurrentOwner` will re-derive in full:
    //
    //  - `campaign.status in (Scheduled, Published)` — the stored statuses that
    //    can still be locking. `Draft` never owns anything and `Ended` is done.
    //  - `starts_at <= now < ends_at` (a null end runs forever) — the window
    //    contains now, which is what "owns it right now" means. Without the end
    //    bound every long-finished campaign would re-propose its bundles on
    //    every pass for ever.
    //  - the bundle does not already name this campaign — a row already on its
    //    current owner has nothing to hand over, and would otherwise be due on
    //    every pass of the whole campaign.
    //
    // Still identifiers only, and still advisory: `to` is `Active` because a
    // window containing now derives `Active`, but the cron re-reads the row
    // through a scoped repository and decides for itself. A bundle held by two
    // current campaigns joins twice and is de-duplicated below.
    const handover = await this.db
      .select(ids)
      .from(bundle)
      .innerJoin(campaignBundle, eq(campaignBundle.bundleId, bundle.id))
      .innerJoin(campaign, eq(campaign.id, campaignBundle.campaignId))
      .where(
        and(
          inArray(campaign.status, ['Scheduled', 'Published']),
          isNotNull(campaign.startsAt),
          lte(campaign.startsAt, now),
          or(isNull(campaign.endsAt), gt(campaign.endsAt, now)),
          or(isNull(bundle.campaignId), ne(bundle.campaignId, campaign.id)),
        ),
      )
      .all();

    // THE SAFETY NET. Every row that currently holds a capture, whatever its
    // status, schedule or operation.
    //
    // The two queries above only ever reach a row through its WINDOW, so a
    // bundle that has been taken out of the window — switched to Draft, had
    // its end date cleared, had its operation changed — stops being due while
    // still holding the merchant's real price in `pre_sale_price`, and nothing
    // would ever restore it. The write paths now refuse those edits, but a
    // guard only stops the NEXT stranding: it does nothing for a row stranded
    // before it existed, and nothing for a path nobody thought of.
    //
    // This is safe precisely because `to` is advisory: the cron re-derives the
    // real target with `deriveStatus`, so a row that should still be live is a
    // no-op (`target === row.status`), and one that should not is restored by
    // the branch that already exists. It costs one extra indexless scan of a
    // column that is null for all but the handful of bundles on sale right
    // now.
    const stranded = await this.db
      .select(ids)
      .from(bundle)
      .where(isNotNull(bundle.preSalePrice))
      .all();

    const due: DueBundle[] = [
      ...activating.map((r) => ({ ...r, to: 'Active' as const })),
      ...deactivating.map((r) => ({ ...r, to: 'Ended' as const })),
    ];
    // A row one scan already returned must not be handed over twice: the cron
    // would process it, write its status, and then process it again against a
    // now-stale decision.
    const seen = new Set(due.map((r) => r.bundleId));
    const append = (rows: Array<{ shopId: string; bundleId: string }>, to: 'Active' | 'Ended') => {
      for (const r of rows) {
        if (seen.has(r.bundleId)) continue;
        seen.add(r.bundleId);
        due.push({ ...r, to });
      }
    };
    append(handover, 'Active');
    append(stranded, 'Ended');
    return due;
  }
}
