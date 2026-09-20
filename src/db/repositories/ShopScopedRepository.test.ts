import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { BundleRepository } from './BundleRepository';
import { DiscountRepository } from './DiscountRepository';
import { ShopRepository } from './ShopRepository';
import { createFakeD1 } from './testing/fakeD1';
import { NotFoundError } from './types';

const SHOP = 'shop-a';
const OTHER = 'shop-b';

function bundles(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  return { fake, repo: new BundleRepository(createDb(fake.db), SHOP) };
}

// These tests assert on the SQL Drizzle emits, not on returned rows. That is
// the point: the guarantee being proven is that no query a scoped repository
// issues can reach another shop's rows, and only the emitted predicate shows it.
describe('ShopScopedRepository', () => {
  it('scopes findById by shop as well as id', async () => {
    const { fake, repo } = bundles();
    await repo.findById('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/where .*"shop_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('b1');
  });

  it('scopes findAll by shop', async () => {
    const { fake, repo } = bundles();
    await repo.findAll();

    expect(fake.lastQuery().sql).toMatch(/where "bundle"\."shop_id" = \?/i);
    expect(fake.lastQuery().params).toEqual([SHOP]);
  });

  it('scopes update, so another shop’s row cannot be mutated', async () => {
    const { fake, repo } = bundles([{ id: 'b1', shop_id: SHOP }]);
    await repo.update('b1', { name: 'renamed' });

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^update/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
  });

  it('scopes delete', async () => {
    const { fake, repo } = bundles();
    await repo.delete('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^delete/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
  });

  it('injects the shop on insert regardless of what the caller passed', async () => {
    const { fake, repo } = bundles([{ id: 'b1' }]);
    await repo.create({
      name: 'Bundle',
      operation: 'expand',
      items: '[]',
      status: 'Draft',
      // A caller cannot pass shopId through the type, but even a cast one loses:
      ...({ shopId: OTHER } as unknown as Record<string, never>),
    });

    const { params } = fake.lastQuery();
    expect(params).toContain(SHOP);
    expect(params).not.toContain(OTHER);
  });

  it('mints a uuid id and ISO-8601 timestamps on create', async () => {
    const { fake, repo } = bundles([{ id: 'b1' }]);
    await repo.create({ name: 'Bundle', operation: 'expand', items: '[]', status: 'Draft' });

    const strings = fake.lastQuery().params.filter((p): p is string => typeof p === 'string');
    expect(strings.some((p) => /^[0-9a-f-]{36}$/i.test(p))).toBe(true);
    expect(strings.some((p) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p))).toBe(true);
  });

  it('carries the scope into a custom predicate composed through scope()', async () => {
    const fake = createFakeD1(() => []);
    const repo = new DiscountRepository(createDb(fake.db), SHOP);
    await repo.listLive();

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"deleted_at" is null/i);
    expect(params).toContain(SHOP);
  });

  it('updateMirror keeps Shopify’s updated_at instead of stamping now', async () => {
    const fake = createFakeD1(() => []);
    const repo = new DiscountRepository(createDb(fake.db), SHOP);
    await repo.updateMirror('d1', { updatedAt: '2020-01-01T00:00:00.000Z' });

    expect(fake.lastQuery().params).toContain('2020-01-01T00:00:00.000Z');
  });

  it('getById throws NotFoundError when the row is absent', async () => {
    const { repo } = bundles([]);
    await expect(repo.getById('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ShopRepository is unscoped — it is the tenant', async () => {
    const fake = createFakeD1(() => []);
    await new ShopRepository(createDb(fake.db)).findById('shop-a');

    expect(fake.lastQuery().sql).not.toMatch(/"shop_id"/i);
  });
});
