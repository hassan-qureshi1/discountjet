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
  it('issues an activation scan, a deactivation scan, the handover scan and the capture sweep', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);
    expect(fake.queries).toHaveLength(4);
  });

  // Without this one a bundle a campaign published for a FUTURE window is
  // never due at all: publish writes nothing to it, so it is neither
  // `Scheduled` with a start nor `Active` with an end nor holding a capture.
  // Same for every queue with a gap in it, where the outgoing campaign leaves
  // the row `Ended` on a window entirely in the past.
  it('reaches a bundle through the campaign whose window contains now', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const handover = fake.queries[2];
    expect(handover.sql).toMatch(/"campaign_bundle"/i);
    expect(handover.sql).toMatch(/"campaign"/i);
    // The window CONTAINS now — both bounds. Without the end bound every
    // long-finished campaign would re-propose its bundles on every pass.
    expect(handover.sql).toMatch(/"starts_at" <= \?/i);
    expect(handover.sql).toMatch(/"ends_at" is null or "campaign"\."ends_at" > \?/i);
    // And only where the bundle does not already name that campaign.
    expect(handover.sql).toMatch(/"campaign_id" is null or "bundle"\."campaign_id" <> "campaign"\."id"/i);
    expect(handover.params).toEqual(['Scheduled', 'Published', NOW, NOW]);
  });

  // Two current campaigns on one bundle is a state publish refuses, but the
  // join would return the row twice if the dates were edited underneath it —
  // and the cron would then process it, write its status, and process it again
  // against a now-stale decision.
  it('returns a bundle once even when two current campaigns join to it', async () => {
    const { scanner: s } = scanner((q) =>
      (q.params.length === 4
        ? [{ shop_id: 'shop-a', id: 'b1' }, { shop_id: 'shop-a', id: 'b1' }]
        : []));

    await expect(s.findDue(NOW)).resolves.toEqual([
      { shopId: 'shop-a', bundleId: 'b1', to: 'Active' },
    ]);
  });

  // The safety net. A guard stops the next stranding; this is what reaches a
  // row that is already stranded, or stranded by a path nobody thought of.
  it('selects every row still holding a pre-sale capture, whatever its window', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const sweep = fake.queries[3];
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
