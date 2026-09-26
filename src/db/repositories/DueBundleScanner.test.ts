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
  it('issues one activation scan and one deactivation scan', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);
    expect(fake.queries).toHaveLength(2);
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
