import { describe, expect, it } from 'vitest';
import { formatWindowLabel, fromUtcIso, toUtcIso } from './schedule';

// This suite deliberately runs in a NON-UTC zone. The schedule fields are UTC
// everywhere — what the merchant types, what we store, what we show — so the
// thing worth proving is that the host machine's timezone never leaks in. Run
// in UTC, an implementation that wrongly used local time would pass every
// assertion below and the file would be worthless.
process.env.TZ = 'Australia/Sydney';

// Guard against the assignment above silently not taking effect. Node/V8 can
// cache timezone data the first time Date/Intl is used in a process; if some
// earlier module in this worker already resolved the system timezone before
// this line ran, `process.env.TZ = ...` above would be a no-op and every
// assertion below would still "pass" without ever exercising a non-UTC host.
// Fail loudly instead of silently degrading.
const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (resolvedZone !== 'Australia/Sydney') {
  throw new Error(
    '[schedule.test] process.env.TZ = \'Australia/Sydney\' did not take effect '
      + `(resolved timezone is '${resolvedZone}'). This suite proves the host's `
      + 'timezone does not leak into a UTC-only schedule, which it can only do '
      + 'while actually running in a non-UTC zone: run it with '
      + '\'TZ=Australia/Sydney npx vitest run web/lib/schedule.test.ts\', or isolate '
      + 'this file into its own worker/process so no earlier module can cache the '
      + 'system timezone first.',
  );
}

describe('toUtcIso', () => {
  // The host is UTC+10/+11. A local-time parse would return 2026-10-02T23:00Z.
  it('treats the entered value as UTC, not as host wall-clock time', () => {
    expect(toUtcIso('2026-10-03', '09:00')).toBe('2026-10-03T09:00:00.000Z');
  });

  it('is unaffected by the host timezone across a host DST transition', () => {
    // Sydney moves to AEDT (+10 -> +11) on 2026-10-04. Under a local parse the
    // offset applied here would differ from the case above; under UTC it cannot.
    expect(toUtcIso('2026-10-05', '02:00')).toBe('2026-10-05T02:00:00.000Z');
  });

  it('produces a fixed-width Z-suffixed string, so the server index stays sane', () => {
    expect(toUtcIso('2026-01-05', '07:05')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('throws on an incomplete value rather than emitting an Invalid Date', () => {
    expect(() => toUtcIso('2026-10-03', '')).toThrow(RangeError);
  });

  it('throws on an unparseable value rather than returning a fallback', () => {
    expect(() => toUtcIso('not-a-date', '09:00')).toThrow(RangeError);
  });
});

describe('fromUtcIso', () => {
  // A local-time read on this host would return 19:00 for a 09:00Z instant.
  it('reads back the UTC components, not the host-local ones', () => {
    expect(fromUtcIso('2026-10-03T09:00:00.000Z')).toEqual({ date: '2026-10-03', time: '09:00' });
  });

  it('round-trips through toUtcIso unchanged', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-10-03', '09:00'));
    expect({ date, time }).toEqual({ date: '2026-10-03', time: '09:00' });
  });

  it('round-trips a value whose host-local date differs from its UTC date', () => {
    // 23:30Z on the 3rd is 09:30 on the 4th in Sydney — a local read would
    // return the wrong DAY, not merely the wrong time.
    const { date, time } = fromUtcIso(toUtcIso('2026-10-03', '23:30'));
    expect({ date, time }).toEqual({ date: '2026-10-03', time: '23:30' });
  });

  it('zero-pads, so the values drop straight into a date/time input', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-01-05', '07:05'));
    expect(date).toBe('2026-01-05');
    expect(time).toBe('07:05');
  });

  it('throws on an unparseable value rather than returning a fallback', () => {
    expect(() => fromUtcIso('nonsense')).toThrow(RangeError);
  });
});

describe('formatWindowLabel', () => {
  it('renders the UTC date and time, never the host-local ones', () => {
    const label = formatWindowLabel('2026-10-03T09:00:00.000Z');
    expect(label).toContain('Oct 3, 2026');
    expect(label).toMatch(/9:00\s?am/i);
    // The host-local rendering would be 7:00 PM on this machine.
    expect(label).not.toMatch(/7:00\s?pm/i);
  });

  it('says UTC, and never a host-local offset', () => {
    const label = formatWindowLabel('2026-10-03T09:00:00.000Z');
    expect(label).toContain('UTC');
    expect(label).not.toMatch(/GMT[+-]\d/);
    expect(label).not.toMatch(/AEST|AEDT/);
  });
});
