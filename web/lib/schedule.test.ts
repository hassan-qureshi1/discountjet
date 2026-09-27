import { describe, expect, it } from 'vitest';
import { formatWindowLabel, fromUtcIso, toUtcIso } from './schedule';

// The merchant works in their own timezone; UTC is storage only. These tests
// are therefore only meaningful in a NON-UTC zone: run in UTC, an
// implementation that never converted at all would pass every assertion below
// and the file would be worthless.
process.env.TZ = 'Australia/Sydney';

// Guard against the assignment above silently not taking effect. Node/V8 can
// cache timezone data the first time Date/Intl is used in a process; if some
// earlier module in this worker already resolved the system timezone before
// this line ran, `process.env.TZ = ...` above would be a no-op and every
// assertion below would still "pass" without ever exercising a conversion.
// Fail loudly instead of silently degrading.
const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (resolvedZone !== 'Australia/Sydney') {
  throw new Error(
    '[schedule.test] process.env.TZ = \'Australia/Sydney\' did not take effect '
      + `(resolved timezone is '${resolvedZone}'). This suite proves local time is `
      + 'converted to UTC and back, which it can only do while actually running in '
      + 'a non-UTC zone: run it with '
      + '\'TZ=Australia/Sydney npx vitest run web/lib/schedule.test.ts\', or isolate '
      + 'this file into its own worker/process so no earlier module can cache the '
      + 'system timezone first.',
  );
}

describe('toUtcIso', () => {
  it('reads the entered value as the merchant’s LOCAL time and stores UTC', () => {
    // 19:00 in Sydney (AEST, UTC+10) is 09:00Z.
    expect(toUtcIso('2026-10-03', '19:00')).toBe('2026-10-03T09:00:00.000Z');
  });

  it('applies the offset in force on that date, not a fixed one', () => {
    // Sydney moves to AEDT (+11) on 2026-10-04, so this is 15:00Z the day
    // BEFORE — a fixed +10 would give 16:00Z, and a UTC parse 02:00Z.
    expect(toUtcIso('2026-10-05', '02:00')).toBe('2026-10-04T15:00:00.000Z');
  });

  it('produces a fixed-width Z-suffixed string, so the server index stays sane', () => {
    expect(toUtcIso('2026-01-05', '07:05')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('throws on an incomplete value rather than emitting an Invalid Date', () => {
    expect(() => toUtcIso('2026-10-03', '')).toThrow(RangeError);
  });
});

describe('fromUtcIso', () => {
  it('converts stored UTC back into the merchant’s local wall clock', () => {
    expect(fromUtcIso('2026-10-03T09:00:00.000Z')).toEqual({ date: '2026-10-03', time: '19:00' });
  });

  it('round-trips through toUtcIso', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-10-03', '19:00'));
    expect({ date, time }).toEqual({ date: '2026-10-03', time: '19:00' });
  });

  it('round-trips across a DST transition', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-10-05', '02:00'));
    expect({ date, time }).toEqual({ date: '2026-10-05', time: '02:00' });
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
  it('renders the stored instant in the reader’s local time', () => {
    const label = formatWindowLabel('2026-10-03T09:00:00.000Z');
    expect(label).toContain('Oct 3, 2026');
    expect(label).toMatch(/7:00\s?pm/i);
  });

  // The offset was noise on every line of the card. The whole point of showing
  // local time is that the merchant does not have to think about offsets.
  it('never prints a timezone offset or abbreviation', () => {
    const label = formatWindowLabel('2026-10-03T09:00:00.000Z');
    expect(label).not.toMatch(/GMT[+-]\d/);
    expect(label).not.toMatch(/AEST|AEDT|UTC/);
  });
});
