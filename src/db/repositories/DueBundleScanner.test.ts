import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { DueBundleScanner } from './DueBundleScanner';
import { createFakeD1 } from './testing/fakeD1';

const NOW = '2026-10-03T09:00:00.000Z';

function scanner(rowsFor: Parameters<typeof createFakeD1>[0] = () => []) {
  const fake = createFakeD1(rowsFor);
  return { fake, scanner: new DueBundleScanner(createDb(fake.db)) };
}

describe('DueBundleScanner', () => {
  it('issues an activation scan, a deactivation scan and the capture sweep', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);
    expect(fake.queries).toHaveLength(3);
  });

  // The safety net. A guard stops the next stranding; this is what reaches a
  // row that is already stranded, or stranded by a path nobody thought of.
  it('selects every row still holding a pre-sale capture, whatever its window', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const sweep = fake.queries[2];
    expect(sweep.sql).toMatch(/"pre_sale_price" is not null/i);
    // No status, no window: that is the whole point of this one.
    expect(sweep.sql).not.toMatch(/"status"/i);
    expect(sweep.params).toEqual([]);
  });

  it('hands a capture-holding row to the cron, advisory `to` and all', async () => {
    const { scanner: s } = scanner((q) =>
      (q.params.length === 0 ? [{ shop_id: 'shop-a', id: 'stranded' }] : []));

    await expect(s.findDue(NOW)).resolves.toEqual([
      { shopId: 'shop-a', bundleId: 'stranded', to: 'Ended' },
    ]);
  });

  it('never returns the same bundle twice when both a window scan and the sweep find it', async () => {
    const { scanner: s } = scanner((q) =>
      (q.params[0] === 'Scheduled' ? [{ shop_id: 'shop-a', id: 'b1' }] : []).concat(
        q.params.length === 0 ? [{ shop_id: 'shop-a', id: 'b1' }] : [],
      ));

    await expect(s.findDue(NOW)).resolves.toEqual([
      { shopId: 'shop-a', bundleId: 'b1', to: 'Active' },
    ]);
  });

  it('selects Scheduled rows whose start has arrived', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const [activation] = fake.queries;
    expect(activation.sql).toMatch(/"status" = \?/i);
    expect(activation.sql).toMatch(/"schedule_start" <= \?/i);
    expect(activation.params).toEqual(['Scheduled', NOW]);
  });

  it('selects Active rows whose end has arrived', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const [, deactivation] = fake.queries;
    expect(deactivation.sql).toMatch(/"schedule_end" <= \?/i);
    expect(deactivation.params).toEqual(['Active', NOW]);
  });

  // The point of the escape hatch: it may read ids, and nothing else.
  it('selects identifiers only — never bundle data', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    for (const q of fake.queries) {
      expect(q.sql).toMatch(/^select /i);
      expect(q.sql).not.toMatch(/"name"/i);
      expect(q.sql).not.toMatch(/"price"/i);
      expect(q.sql).not.toMatch(/"metafield_gid"/i);
    }
  });

  it('tags each row with the transition its scan implies', async () => {
    const { scanner: s } = scanner((q) =>
      q.params[0] === 'Scheduled'
        ? [{ shop_id: 'shop-a', id: 'b1' }]
        : [{ shop_id: 'shop-b', id: 'b2' }]);

    await expect(s.findDue(NOW)).resolves.toEqual([
      { shopId: 'shop-a', bundleId: 'b1', to: 'Active' },
      { shopId: 'shop-b', bundleId: 'b2', to: 'Ended' },
    ]);
  });

  it('is unscoped by design — it never binds a shop id', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);
    for (const q of fake.queries) {
      expect(q.sql).not.toMatch(/"shop_id" = \?/i);
    }
  });
});
