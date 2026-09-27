/**
 * Local wall-clock ⇄ UTC conversion for the bundle schedule fields.
 *
 * The merchant works entirely in their own timezone: they type a local time,
 * and they read a local time back. UTC is storage and transport only — it is
 * what the API persists, what the due-scan compares as a string, and what the
 * cron judges a window against. The merchant never sees it and never has to
 * think about offsets.
 *
 * All of that conversion lives here, and only here, so there is one place to
 * test it and one place to change it if the product ever moves to the store's
 * timezone instead of the browser's.
 */

/**
 * `'2026-10-03'` + `'19:00'` -> that local instant as a UTC ISO string.
 *
 * `new Date('2026-10-03T19:00')` — note: NO trailing Z — parses as local
 * wall-clock time, which is what makes daylight saving the platform's problem
 * rather than ours: the offset in force on that specific date is applied, not
 * a fixed one. Do not "tidy" this into a UTC parse.
 */
export function toUtcIso(date: string, time: string): string {
  const parsed = new Date(`${date}T${time}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`[schedule] not a valid local date and time: ${date} ${time}`);
  }
  return parsed.toISOString();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The inverse of `toUtcIso`, in values a date/time input accepts directly. */
export function fromUtcIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`[schedule] not a valid ISO datetime: ${iso}`);
  }
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * A human label for a stored UTC instant, rendered in the reader's local time —
 * e.g. `Sat, Oct 3, 2026, 7:00 PM`.
 *
 * Deliberately no `timeZoneName`. An offset like `GMT+5` on every line is noise:
 * the point of showing local time is that the merchant does not have to think
 * about offsets at all, and a label that announces one invites them to wonder
 * whether some other value was meant.
 */
export function formatWindowLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
