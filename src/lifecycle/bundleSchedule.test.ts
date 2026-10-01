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
    // Real shop rows carry a currency; the cron converts minor units to the
    // major units both metafield transports speak and refuses to guess one.
    currency: 'USD',
  } as ShopRow;
}

function bundleRow(over: Partial<BundleRow> & { id: string; shopId: string }): BundleRow {
  return {
    name: 'A bundle',
    operation: 'update',
    parentVariantId: null,
    price: null,
    compareAtPrice: null,
    preSalePrice: null,
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
    readVariantPrice: vi.fn(async () => ({ priceMinor: 310000, currencyCode: 'USD' })),
    setVariantPricing: vi.fn(async () => {}),
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

describe('runBundleSchedule transports', () => {
  function expandRow(over: Partial<BundleRow>): BundleRow {
    return bundleRow({
      id: 'b1',
      shopId: 'shop-a',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      price: 1000,
      ...over,
    } as Partial<BundleRow> & { id: string; shopId: string });
  }

  it('writes the composition metafield when an expand bundle activates', async () => {
    const rows = [expandRow({ scheduleStart: PAST })];
    const { deps, transports, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.writeComposition).toHaveBeenCalledTimes(1);
    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Active');
    expect(row.metafieldState).toBe('Written');
  });

  it('clears the composition metafield when an expand bundle ends', async () => {
    const rows = [expandRow({ status: 'Active', scheduleEnd: PAST, metafieldState: 'Written' })];
    const { deps, transports, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.clearComposition).toHaveBeenCalledTimes(1);
    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Ended');
    expect(row.metafieldState).toBe('Cleared');
  });

  it('batches every merge change in a shop into ONE applyMergeBatch call', async () => {
    const rows = [
      bundleRow({ id: 'm1', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p1', price: 1000, scheduleStart: PAST }),
      bundleRow({ id: 'm2', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p2', price: 2000, scheduleStart: PAST }),
      bundleRow({ id: 'm3', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p3', price: 3000, status: 'Active', scheduleEnd: PAST, metafieldState: 'Written' }),
    ];
    const { deps, transports } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.applyMergeBatch).toHaveBeenCalledTimes(1);
    const [, , changes] = vi.mocked(transports.applyMergeBatch).mock.calls[0];
    // Both sides are normalised to variant GIDs — `applyMergeBatch` matches a
    // removal against a stored entry by exact string.
    expect(changes.upserts.map((u) => u.parentVariantId).sort()).toEqual([
      'gid://shopify/ProductVariant/p1',
      'gid://shopify/ProductVariant/p2',
    ]);
    expect(changes.removeParentVariantIds).toEqual(['gid://shopify/ProductVariant/p3']);
  });

  it('records the failure and leaves status untouched when the Admin write throws', async () => {
    const rows = [expandRow({ scheduleStart: PAST })];
    const transports = noopTransports();
    transports.writeComposition = vi.fn(async () => { throw new Error('Shopify is down'); });
    const { deps, reposFor } = harness(rows, [shop('shop-a')], transports);

    await runBundleSchedule(ENV, NOW, deps);

    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleError).toContain('Shopify is down');
  });

  it('keeps processing the group after one bundle fails', async () => {
    const rows = [
      expandRow({ id: 'b1', scheduleStart: PAST }),
      expandRow({ id: 'b2', parentVariantId: 'gid://shopify/ProductVariant/2', scheduleStart: PAST }),
    ];
    const transports = noopTransports();
    transports.writeComposition = vi.fn(async (_e, _d, parent) => {
      if (parent.endsWith('/1')) throw new Error('nope');
      return { metafieldGid: 'gid://shopify/Metafield/2' };
    });
    const { deps, reposFor } = harness(rows, [shop('shop-a')], transports);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
    expect((await reposFor('shop-a').bundles.findById('b2'))!.status).toBe('Active');
  });

  it('clears scheduleError on a later successful transition', async () => {
    const rows = [expandRow({ scheduleStart: PAST, scheduleError: 'an old failure' })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.scheduleError).toBeNull();
  });

  it('refuses to activate an update bundle on a non-Plus shop, and says why', async () => {
    const rows = [bundleRow({ id: 'u1', shopId: 'shop-a', operation: 'update', scheduleStart: PAST })];
    const basic = { ...shop('shop-a'), planName: 'Basic', shopifyPlus: 0 } as ShopRow;
    const { deps, reposFor } = harness(rows, [basic]);

    await runBundleSchedule(ENV, NOW, deps);

    const row = (await reposFor('shop-a').bundles.findById('u1'))!;
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleError).toMatch(/plan/i);
  });

  // A failed batch is all-or-nothing: one metafield, one write. No bundle in it
  // may come out half-applied.
  it('leaves every bundle in a failed merge batch with its old status', async () => {
    const rows = [
      bundleRow({ id: 'm1', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p1', price: 1000, scheduleStart: PAST }),
      bundleRow({ id: 'm2', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p2', price: 2000, status: 'Active', scheduleEnd: PAST, metafieldState: 'Written' }),
    ];
    const transports = noopTransports();
    transports.applyMergeBatch = vi.fn(async () => { throw new Error('merge_bundles write rejected'); });
    const { deps, reposFor } = harness(rows, [shop('shop-a')], transports);

    await runBundleSchedule(ENV, NOW, deps);

    const m1 = (await reposFor('shop-a').bundles.findById('m1'))!;
    const m2 = (await reposFor('shop-a').bundles.findById('m2'))!;
    expect(m1.status).toBe('Scheduled');
    expect(m1.metafieldState).toBe('NotYet');
    expect(m2.status).toBe('Active');
    expect(m2.metafieldState).toBe('Written');
    expect(m1.scheduleError).toContain('merge_bundles write rejected');
    expect(m2.scheduleError).toContain('merge_bundles write rejected');
  });

  // A D1 failure AFTER the batch succeeded is not a batch failure: Shopify has
  // already agreed, so the rows that persisted must not be left carrying a
  // merchant-visible error that no later pass ever clears.
  it('leaves the merge bundles that persisted clean when one row fails to persist', async () => {
    const rows = [
      bundleRow({ id: 'm1', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p1', price: 1000, scheduleStart: PAST }),
      bundleRow({ id: 'm2', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p2', price: 2000, scheduleStart: PAST }),
    ];
    const { deps, transports, reposFor } = harness(rows, [shop('shop-a')]);
    const repos = reposFor('shop-a');
    const real = repos.bundles.setMetafieldState.bind(repos.bundles);
    repos.bundles.setMetafieldState = vi.fn(async (id, state, gid) => {
      if (id === 'm1') throw new Error('D1 write failed');
      return real(id, state, gid);
    });

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.applyMergeBatch).toHaveBeenCalledTimes(1);
    const m1 = (await repos.bundles.findById('m1'))!;
    const m2 = (await repos.bundles.findById('m2'))!;
    expect(m1.status).toBe('Scheduled');
    expect(m1.scheduleError).toContain('D1 write failed');
    expect(m2.status).toBe('Active');
    expect(m2.scheduleError).toBeNull();
  });

  // Guessing USD would price a JPY shop's bundle a hundredfold wrong.
  it('refuses to convert prices for a shop with no currency', async () => {
    const rows = [expandRow({ scheduleStart: PAST })];
    const noCurrency = { ...shop('shop-a'), currency: null } as ShopRow;
    const { deps, transports, reposFor } = harness(rows, [noCurrency]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.writeComposition).not.toHaveBeenCalled();
    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleError).toMatch(/currency/i);
  });

  // A merge bundle with no price must not be published at 0.00.
  it('refuses to publish a merge bundle that has no price', async () => {
    const rows = [
      bundleRow({ id: 'm1', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p1', price: null, scheduleStart: PAST }),
    ];
    const { deps, transports, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.applyMergeBatch).not.toHaveBeenCalled();
    const row = (await reposFor('shop-a').bundles.findById('m1'))!;
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleError).toMatch(/no price/i);
  });
});

function pricingTransports(over: Partial<BundleTransports> = {}): BundleTransports {
  return { ...noopTransports(), ...over };
}

const PARENT = 'gid://shopify/ProductVariant/1';

it('captures the pre-sale price and applies the sale when a window opens', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
    })],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  expect(t.setVariantPricing).toHaveBeenCalledWith(
    ENV, 'shop-a.myshopify.com', PARENT,
    expect.objectContaining({ priceMinor: 279000 }),
  );
  // The live price just read is what must be captured — not the sale price.
  expect(await h.reposFor('shop-a').bundles.findById('b1')).toMatchObject({ preSalePrice: 310000, status: 'Active' });
});

// Review Focus #2 — the restore must stay possible after a failed write.
it('leaves pre_sale_price set when the restore write fails, so the next pass retries', async () => {
  const t = pricingTransports({
    setVariantPricing: vi.fn(async () => { throw new Error('Shopify said no'); }),
  });
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, preSalePrice: 310000, status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  const row = (await h.reposFor('shop-a').bundles.findById('b1'))!;
  // Clearing this before Shopify confirmed would strand the sale forever with
  // nothing left to restore from.
  expect(row.preSalePrice).toBe(310000);
  expect(row.scheduleError).toMatch(/Shopify said no/);
});

// Review Focus #3 — the campaign may be gone; the restore must not care.
it('restores a bundle whose campaign was deleted mid-sale', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, preSalePrice: 310000, campaignId: null, status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  expect(t.setVariantPricing).toHaveBeenCalledWith(
    ENV, 'shop-a.myshopify.com', PARENT,
    expect.objectContaining({ priceMinor: 310000 }),
  );
  expect((await h.reposFor('shop-a').bundles.findById('b1'))!.preSalePrice).toBeNull();
});

// Review Focus #4 — one unpriceable row must not abort the shop's sweep.
it('skips a bundle with no parent variant and records why, without aborting the pass', async () => {
  const t = pricingTransports();
  const h = harness(
    [
      bundleRow({
        id: 'bad', shopId: 'shop-a', operation: 'expand', parentVariantId: null,
        price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
      }),
      bundleRow({
        id: 'good', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
        price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
      }),
    ],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  const bad = await h.reposFor('shop-a').bundles.findById('bad');
  const good = await h.reposFor('shop-a').bundles.findById('good');
  expect(bad?.scheduleError).toBeTruthy();
  expect(bad?.preSalePrice).toBeNull();
  // The second bundle still got processed — the first did not abort the pass.
  expect(good?.preSalePrice).toBe(310000);
});

// The ordering IS the guarantee: a test of end state alone passes the broken order too.
it('persists the pre-sale capture before it calls Shopify', async () => {
  let seenAtWrite: number | null | undefined;
  let h!: ReturnType<typeof harness>;
  const t = pricingTransports({
    setVariantPricing: vi.fn(async () => {
      seenAtWrite = (await h.reposFor('shop-a').bundles.findById('b1'))!.preSalePrice;
    }),
  });
  h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
    })],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  expect(seenAtWrite).toBe(310000);
});

// The write may have landed even though the call threw (timeout, 502). The
// capture is the only record of the real price, so it must survive.
it('keeps the pre-sale capture when the apply write throws, so a restore is still possible', async () => {
  const t = pricingTransports({
    setVariantPricing: vi.fn(async () => { throw new Error('Shopify said no'); }),
  });
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
    })],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  const row = (await h.reposFor('shop-a').bundles.findById('b1'))!;
  expect(row.preSalePrice).toBe(310000);
  expect(row.status).toBe('Scheduled');
  expect(row.scheduleError).toMatch(/Shopify said no/);
});

it('restores in the currency Shopify reports, not the shop row currency', async () => {
  const t = pricingTransports({
    readVariantPrice: vi.fn(async () => ({ priceMinor: 279000, currencyCode: 'JPY' })),
  });
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, preSalePrice: 310000, status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('shop-a')],
    t,
  );

  await runBundleSchedule(ENV, NOW, h.deps);

  expect(t.setVariantPricing).toHaveBeenCalledWith(
    ENV, 'shop-a.myshopify.com', PARENT,
    expect.objectContaining({ priceMinor: 310000, currencyCode: 'JPY' }),
  );
});
