/**
 * Local wall-clock ⇄ UTC conversion for the bundle schedule fields.
 *
 * The merchant types a time in THEIR browser's timezone; the server stores UTC.
 * All of that conversion lives here, and only here, so there is one place to
 * test it and one place to change it if we ever switch to the store's timezone.
 */

/**
 * `'2026-10-03'` + `'19:00'` -> the same instant as a UTC ISO string.
 *
 * `new Date('2026-10-03T19:00')` — note: NO trailing Z — parses as local
 * wall-clock time, which is what makes DST the platform's problem rather than
 * ours. Do not "tidy" this into a UTC parse.
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

/** The browser's timezone, e.g. `Australia/Sydney`. */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A human label for a stored UTC instant, naming the zone explicitly.
 *
 * The zone is spelled out because the window is set in the BROWSER's timezone,
 * not the store's — printing it is what keeps that from being invisible to a
 * merchant working from somewhere else.
 */
export function formatWindowLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
