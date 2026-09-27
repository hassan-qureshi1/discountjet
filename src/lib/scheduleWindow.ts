/**
 * Pure window logic for bundle scheduling. No I/O, no Hono, no Drizzle — the
 * route and the cron both import from here so there is exactly one definition
 * of what a schedule means.
 */

export type ScheduledStatus = 'Active' | 'Scheduled' | 'Ended';
export type BundleStatus = ScheduledStatus | 'Draft';

/**
 * What the window says the status should be right now.
 *
 * `Draft` is deliberately not a possible result: it is the merchant's manual
 * off-switch, owned by the merchant, and the caller skips derivation entirely
 * for a Draft row.
 *
 * Both comparisons are plain string compares, which is only correct because
 * every stored bound went through `normalizeUtc` — fixed-width, `Z`-suffixed,
 * so lexicographic order IS chronological order.
 *
 * The order of the two checks matters: a window entirely in the past has both
 * `now >= end` and (vacuously) an open start, and `Ended` is the honest answer.
 */
export function deriveStatus(
  start: string | null,
  end: string | null,
  now: string,
): ScheduledStatus {
  if (end !== null && now >= end) return 'Ended';
  if (start !== null && now < start) return 'Scheduled';
  return 'Active';
}

/**
 * The one way a datetime enters the database.
 *
 * Throws rather than returning null on a bad value: a `null` schedule bound
 * means "no bound", i.e. permanently live, which is the most dangerous thing a
 * parse failure could silently turn into.
 */
export function normalizeUtc(input: string): string {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new RangeError(`[scheduleWindow] not a parseable datetime: ${input}`);
  }
  return new Date(ms).toISOString();
}

/**
 * The single gate on whether a bundle's cart-transform metafield should be
 * written to Shopify. Both the save path and the cron pass go through this, so
 * a scheduled bundle cannot be live early via one of them.
 */
export function shouldBeLive(status: BundleStatus): boolean {
  return status === 'Active';
}

/** A closed window must be ordered. Either bound alone, or neither, is fine. */
export function assertWindowOrder(start: string | null, end: string | null): void {
  if (start !== null && end !== null && start >= end) {
    throw new RangeError(`[scheduleWindow] schedule start ${start} is not before end ${end}`);
  }
}
