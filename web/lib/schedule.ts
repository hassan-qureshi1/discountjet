/**
 * UTC date/time handling for the bundle schedule fields.
 *
 * The schedule is UTC everywhere: what the merchant types, what the API
 * stores, what the cron compares, and what we render back. The host machine's
 * timezone is never consulted — that is the whole point, and it is what makes
 * a window mean the same thing to every person who opens the app, wherever
 * they happen to be sitting.
 *
 * All of that lives here, and only here, so there is one place to test it and
 * one place to change it if the product ever moves to the store's timezone.
 */

/**
 * `'2026-10-03'` + `'09:00'` -> that instant as a UTC ISO string.
 *
 * The explicit `Z` is load-bearing: `new Date('2026-10-03T09:00')` without it
 * parses as the HOST's wall-clock time, which would silently shift every
 * merchant's window by their own UTC offset. Do not "tidy" it away.
 */
export function toUtcIso(date: string, time: string): string {
  const parsed = new Date(`${date}T${time}:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`[schedule] not a valid UTC date and time: ${date} ${time}`);
  }
  return parsed.toISOString();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The inverse of `toUtcIso`, in values a date/time input accepts directly.
 *
 * Reads the UTC components rather than the local ones. East of UTC a local
 * read returns the wrong DAY, not merely the wrong time, so this is not a
 * cosmetic distinction.
 */
export function fromUtcIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`[schedule] not a valid ISO datetime: ${iso}`);
  }
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/**
 * A human label for a stored UTC instant — e.g. `Sat, Oct 3, 2026, 9:00 AM UTC`.
 *
 * Forced to `timeZone: 'UTC'` so it agrees with the values in the editor's
 * fields, and suffixed with a literal `UTC` rather than `timeZoneName`, which
 * would render a host-relative abbreviation like `GMT+5` and imply the window
 * had been converted into the reader's own zone.
 */
export function formatWindowLabel(iso: string): string {
  const formatted = new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${formatted} UTC`;
}
