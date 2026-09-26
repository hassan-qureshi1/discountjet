import { describe, expect, it, vi } from 'vitest';
import { runBundleSchedule, type BundleScheduleDeps, type BundleTransports } from './bundleSchedule';
import { createInMemoryRepositories, InMemoryDueBundleScanner } from '../db/repositories/inMemory';
import type { BundleRow, ShopRow } from '../db/repositories';
import type { Env } from '../types/env';

const NOW = '2026-10-03T12:00:00.000Z';
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';
const ENV = {} as Env;

function shop(id: string): ShopRow {
  return {
    id,
    myshopifyDomain: `${id}.myshopify.com`,
    status: 'installed',
    planName: 'Shopify Plus',
  } as ShopRow;
}

function bundleRow(over: Partial<BundleRow> & { id: string; shopId: string }): BundleRow {
  return {
    name: 'A bundle',
    operation: 'update',
    parentVariantId: null,
    price: null,
    metafieldState: 'NotYet',
    metafieldGid: null,
    scheduleStart: null,
    scheduleEnd: null,
    scheduleError: null,
    status: 'Scheduled',
    blockOnFailure: 0,
    createdAt: PAST,
    updatedAt: PAST,
    ...over,
  } as BundleRow;
}

function noopTransports(): BundleTransports {
  return {
    writeComposition: vi.fn(async () => ({ metafieldGid: 'gid://shopify/Metafield/1' })),
    clearComposition: vi.fn(async () => {}),
    applyMergeBatch: vi.fn(async () => ({ metafieldGid: null })),
  };
}

function harness(rows: BundleRow[], shops: ShopRow[], transports = noopTransports()) {
  // One repository set per shop, over ONE shared row array, so a cross-tenant
  // write would be visible to the other shop's repositories.
  const byShop = new Map<string, ReturnType<typeof createInMemoryRepositories>>();
  for (const s of shops) {
    byShop.set(s.id, createInMemoryRepositories(s.id, { shops, bundles: rows }));
  }
  const deps: BundleScheduleDeps = {
    scanner: new InMemoryDueBundleScanner(rows),
    shops: createInMemoryRepositories('unused', { shops }).shops,
    reposFor: (shopId) => {
      const repos = byShop.get(shopId);
      if (!repos) throw new Error(`no repositories for ${shopId}`);
      return repos;
    },
    getToken: vi.fn(async () => 'shpat_token'),
    transports,
  };
  return { deps, rows, transports, reposFor: (id: string) => byShop.get(id)! };
}

describe('runBundleSchedule', () => {
  it('activates a Scheduled bundle whose start has arrived', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Active');
  });

  it('ends an Active bundle whose end has arrived', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', status: 'Active', scheduleEnd: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Ended');
  });

  // Review Focus #1 — the scanner tags this 'Active'; re-deriving must override it.
  it('sends a window entirely in the past straight to Ended, never through Active', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST, scheduleEnd: PAST })];
    const { deps, reposFor, transports } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Ended');
    expect(transports.writeComposition).not.toHaveBeenCalled();
  });

  it('never touches a Draft bundle, whatever its window says', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', status: 'Draft', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Draft');
  });

  it('leaves a not-yet-due bundle alone', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: FUTURE })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
  });

  it('is idempotent — a second identical pass changes nothing', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);
    const afterFirst = await reposFor('shop-a').bundles.findById('b1');
    await runBundleSchedule(ENV, NOW, deps);

    expect(await reposFor('shop-a').bundles.findById('b1')).toEqual(afterFirst);
  });

  it('changes no status anywhere in a group whose shop has no token', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);
    deps.getToken = vi.fn(async () => null);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
  });

  it('skips an uninstalled shop', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const uninstalled = { ...shop('shop-a'), status: 'uninstalled' } as ShopRow;
    const { deps, reposFor } = harness(rows, [uninstalled]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
  });

  // Review Focus #5 — the scoped re-read is what makes a scanner bug harmless.
  it('never writes shop A’s row through shop B’s repositories', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a'), shop('shop-b')]);
    // A deliberately wrong pairing, as a scanner bug would produce.
    deps.scanner = { findDue: async () => [{ shopId: 'shop-b', bundleId: 'b1', to: 'Active' }] };

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
    expect(await reposFor('shop-b').bundles.findById('b1')).toBeNull();
  });

  it('processes every shop in the pass, not just the first', async () => {
    const rows = [
      bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST }),
      bundleRow({ id: 'b2', shopId: 'shop-b', scheduleStart: PAST }),
    ];
    const { deps, reposFor } = harness(rows, [shop('shop-a'), shop('shop-b')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Active');
    expect((await reposFor('shop-b').bundles.findById('b2'))!.status).toBe('Active');
  });
});
