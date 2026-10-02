import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { bundle } from '../schema';
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
 * GID, and it has no write path. Everything the cron then does with these ids
 * goes back through `createRepositories(env.DB, shopId)`, which re-reads the row
 * under `where shop_id = ?` — so a bug here surfaces as a row that reads as
 * absent, not as a cross-tenant write.
 *
 * The two window queries are served by `bundle_due_start_idx` /
 * `bundle_due_end_idx`, which are status-leading rather than shop-leading for
 * exactly this reason.
 */
export class DueBundleScanner implements IDueBundleScanner {
  constructor(private readonly db: Db) {}

  /**
   * `now` is a parameter rather than read inside, so tests drive the clock
   * instead of mocking `Date`.
   *
   * Separate queries rather than one `UNION ALL`: identical index usage, and
   * the result needs a per-branch tag anyway.
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
    // A row the window scans already returned must not be handed over twice:
    // the cron would process it, write its status, and then process it again
    // against a now-stale decision.
    const seen = new Set(due.map((r) => r.bundleId));
    for (const r of stranded) {
      if (seen.has(r.bundleId)) continue;
      seen.add(r.bundleId);
      due.push({ ...r, to: 'Ended' as const });
    }
    return due;
  }
}
