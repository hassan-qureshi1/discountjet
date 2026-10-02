import { describe, expect, it } from 'vitest';
import { windowsOverlap } from './windowOverlap';

const w = (startsAt: string | null, endsAt: string | null) => ({ startsAt, endsAt });

const NOV = w('2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z');
const DEC = w('2026-12-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z');

describe('windowsOverlap', () => {
  it('separates two windows that do not meet', () => {
    expect(windowsOverlap(NOV, DEC)).toBe(false);
  });

  it('is symmetric', () => {
    expect(windowsOverlap(DEC, NOV)).toBe(windowsOverlap(NOV, DEC));
  });

  it('finds a genuine overlap', () => {
    expect(windowsOverlap(NOV, w('2026-11-15T00:00:00.000Z', '2026-12-15T00:00:00.000Z'))).toBe(true);
  });

  it('counts one window wholly inside another', () => {
    expect(windowsOverlap(NOV, w('2026-11-10T00:00:00.000Z', '2026-11-20T00:00:00.000Z'))).toBe(true);
  });

  // Review Focus #2 — the case that makes sequential scheduling usable at all.
  it('does NOT count windows that merely touch', () => {
    // November ends at the instant December begins. Refusing this would reject
    // every sensible back-to-back schedule a merchant writes.
    const touching = w('2026-11-30T00:00:00.000Z', '2026-12-20T00:00:00.000Z');

    expect(windowsOverlap(NOV, touching)).toBe(false);
  });

  // Review Focus #1 — the dangerous reading of null.
  it('treats a null end as running forever, so it overlaps everything after its start', () => {
    const unbounded = w('2026-11-01T00:00:00.000Z', null);

    expect(windowsOverlap(unbounded, DEC)).toBe(true);
    // Reading null as "no constraint" would return false here and let a second
    // campaign publish straight through an unbounded one.
  });

  it('treats a null end as NOT reaching backwards before its start', () => {
    const unbounded = w('2026-12-01T00:00:00.000Z', null);

    expect(windowsOverlap(NOV, unbounded)).toBe(false);
  });

  it('treats a null start as already running', () => {
    const alwaysOn = w(null, '2026-11-15T00:00:00.000Z');

    expect(windowsOverlap(alwaysOn, NOV)).toBe(true);
    expect(windowsOverlap(alwaysOn, DEC)).toBe(false);
  });

  it('counts two unbounded windows as overlapping', () => {
    expect(windowsOverlap(w(null, null), w(null, null))).toBe(true);
  });
});
