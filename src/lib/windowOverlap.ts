/**
 * Whether two campaign windows collide.
 *
 * Pure, because this is the rule that decides whether a merchant is refused at
 * publish, and it should be provable without a database or a clock.
 *
 * Windows are half-open — `[start, end)` — which is what makes sequential
 * scheduling usable: a campaign ending at the exact instant the next begins
 * does NOT overlap it, so a merchant can write back-to-back dates the obvious
 * way. Timestamps are normalized UTC ISO-8601 and compare correctly as
 * strings, the same way the due-scan compares them.
 */
export interface Window {
  startsAt: string | null;
  endsAt: string | null;
}

/** Sentinels, so the comparison below needs no null branches. */
const BEGINNING = '';
const FOREVER = '￿';

export function windowsOverlap(a: Window, b: Window): boolean {
  // A null start is "already running", a null end is "runs forever". The
  // second matters most: reading null as "no constraint" would make an
  // unbounded campaign overlap NOTHING, and a second campaign could publish
  // straight through it.
  const aStart = a.startsAt ?? BEGINNING;
  const aEnd = a.endsAt ?? FOREVER;
  const bStart = b.startsAt ?? BEGINNING;
  const bEnd = b.endsAt ?? FOREVER;

  return aStart < bEnd && bStart < aEnd;
}
