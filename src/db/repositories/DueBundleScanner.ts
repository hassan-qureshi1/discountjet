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
 * Both queries are served by `bundle_due_start_idx` / `bundle_due_end_idx`,
 * which are status-leading rather than shop-leading for exactly this reason.
 */
export class DueBundleScanner implements IDueBundleScanner {
  constructor(private readonly db: Db) {}

  /**
   * `now` is a parameter rather than read inside, so tests drive the clock
   * instead of mocking `Date`.
   *
   * Two queries rather than one `UNION ALL`: identical index usage, and the
   * result needs a per-branch tag anyway.
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

    return [
      ...activating.map((r) => ({ ...r, to: 'Active' as const })),
      ...deactivating.map((r) => ({ ...r, to: 'Ended' as const })),
    ];
  }
}
