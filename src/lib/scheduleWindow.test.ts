import { describe, expect, it } from 'vitest';
import { assertWindowOrder, deriveStatus, normalizeUtc, shouldBeLive } from './scheduleWindow';

const START = '2026-10-03T09:00:00.000Z';
const END = '2026-10-05T23:00:00.000Z';
const BEFORE = '2026-10-01T00:00:00.000Z';
const INSIDE = '2026-10-04T00:00:00.000Z';
const AFTER = '2026-10-06T00:00:00.000Z';

describe('deriveStatus', () => {
  it.each([
    ['no bounds', null, null, INSIDE, 'Active'],
    ['start only, before', START, null, BEFORE, 'Scheduled'],
    ['start only, after', START, null, AFTER, 'Active'],
    ['end only, before', null, END, INSIDE, 'Active'],
    ['end only, after', null, END, AFTER, 'Ended'],
    ['both, before', START, END, BEFORE, 'Scheduled'],
    ['both, inside', START, END, INSIDE, 'Active'],
    ['both, after', START, END, AFTER, 'Ended'],
  ])('%s', (_label, start, end, now, expected) => {
    expect(deriveStatus(start, end, now)).toBe(expected);
  });

  // Review Focus #2 — an off-by-one here silently leaves a bundle live for a pass.
  it('treats now === start as Active (the window is open at its first instant)', () => {
    expect(deriveStatus(START, END, START)).toBe('Active');
  });

  it('treats now === end as Ended (the window is shut at its last instant)', () => {
    expect(deriveStatus(START, END, END)).toBe('Ended');
  });

  it('ends a window that is entirely in the past rather than activating it', () => {
    expect(deriveStatus(START, END, '2027-01-01T00:00:00.000Z')).toBe('Ended');
  });
});

describe('normalizeUtc', () => {
  it('passes a normalized UTC string through unchanged', () => {
    expect(normalizeUtc(START)).toBe(START);
  });

  // Review Focus #3 — stored verbatim, a non-Z offset makes the index comparison lie.
  it('converts a non-Z offset to the same instant in Z form', () => {
    expect(normalizeUtc('2026-10-03T19:00:00+10:00')).toBe('2026-10-03T09:00:00.000Z');
  });

  it('pads a second-less value to fixed width, so string compare stays chronological', () => {
    expect(normalizeUtc('2026-10-03T09:00:00Z')).toBe(START);
  });

  it('throws on an unparseable value rather than returning null', () => {
    expect(() => normalizeUtc('next tuesday')).toThrow(RangeError);
  });
});

describe('shouldBeLive', () => {
  it('is true only for Active', () => {
    expect(shouldBeLive('Active')).toBe(true);
    expect(shouldBeLive('Scheduled')).toBe(false);
    expect(shouldBeLive('Ended')).toBe(false);
    expect(shouldBeLive('Draft')).toBe(false);
  });
});

describe('assertWindowOrder', () => {
  it('accepts a start before its end', () => {
    expect(() => assertWindowOrder(START, END)).not.toThrow();
  });

  it('accepts either bound alone, and neither', () => {
    expect(() => assertWindowOrder(START, null)).not.toThrow();
    expect(() => assertWindowOrder(null, END)).not.toThrow();
    expect(() => assertWindowOrder(null, null)).not.toThrow();
  });

  it('rejects a start at or after its end', () => {
    expect(() => assertWindowOrder(END, START)).toThrow(RangeError);
    expect(() => assertWindowOrder(START, START)).toThrow(RangeError);
  });
});
