import { describe, expect, it } from 'vitest';
import { formatWindowLabel, fromUtcIso, toUtcIso } from './schedule';

// These tests are only meaningful in a non-UTC zone: in UTC, a function that
// wrongly parsed the input as UTC would pass every assertion. vitest reads TZ
// from the environment, so this file sets it explicitly.
process.env.TZ = 'Australia/Sydney';

// Guard against the assignment above silently not taking effect. Node/V8 can
// cache timezone data the first time Date/Intl is used in a process; if some
// earlier module in this worker already resolved the system timezone before
// this line ran, `process.env.TZ = ...` above would be a no-op and every
// assertion below would still "pass" against the wrong (or UTC) zone, making
// the whole file worthless. Fail loudly instead of silently degrading.
const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (resolvedZone !== 'Australia/Sydney') {
  throw new Error(
    '[schedule.test] process.env.TZ = \'Australia/Sydney\' did not take effect '
      + `(resolved timezone is '${resolvedZone}'). This suite is only meaningful `
      + 'when it actually runs in Australia/Sydney: run it with '
      + '\'TZ=Australia/Sydney npx vitest run web/lib/schedule.test.ts\', or isolate '
      + 'this file into its own worker/process so no earlier module can cache the '
      + 'system timezone first.',
  );
}

describe('toUtcIso', () => {
  it('treats the entered value as LOCAL wall-clock time, not UTC', () => {
    // 2026-10-03 19:00 in Sydney (AEST, UTC+10) is 09:00Z.
    expect(toUtcIso('2026-10-03', '19:00')).toBe('2026-10-03T09:00:00.000Z');
  });

  it('produces a fixed-width Z-suffixed string, so the server index stays sane', () => {
    expect(toUtcIso('2026-01-05', '07:05')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('throws on an incomplete value rather than emitting an Invalid Date', () => {
    expect(() => toUtcIso('2026-10-03', '')).toThrow();
  });
});

describe('fromUtcIso', () => {
  it('round-trips through toUtcIso', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-10-03', '19:00'));
    expect({ date, time }).toEqual({ date: '2026-10-03', time: '19:00' });
  });

  it('round-trips across a DST transition', () => {
    // Sydney moves to AEDT on 2026-10-04; a naive fixed-offset conversion
    // returns 03:00 here.
    const { date, time } = fromUtcIso(toUtcIso('2026-10-05', '02:00'));
    expect({ date, time }).toEqual({ date: '2026-10-05', time: '02:00' });
  });

  it('zero-pads, so the values drop straight into a date/time input', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-01-05', '07:05'));
    expect(date).toBe('2026-01-05');
    expect(time).toBe('07:05');
  });
});

describe('formatWindowLabel', () => {
  it('names the local date, time and zone', () => {
    const label = formatWindowLabel('2026-10-03T09:00:00.000Z');
    // Node's ICU on this platform renders `undefined`-locale output as
    // "Sat, Oct 3, 2026, 7:00 PM GMT+10" rather than the brief's illustrative
    // "Fri 3 Oct 2026, 9:00 am (AEST)" — different month/day order and zone
    // abbreviation, but the date, time and zone are all still present, which
    // is what this assertion exists to pin.
    expect(label).toContain('Oct 3, 2026');
    expect(label).toMatch(/7:00\s?pm/i);
    expect(label).toMatch(/AEST|GMT\+10/);
  });
});
