import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { BundleItemRepository } from './BundleItemRepository';
import { createFakeD1 } from './testing/fakeD1';

const SHOP = 'shop-a';
const OTHER = 'shop-b';

function repo(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  return { fake, items: new BundleItemRepository(createDb(fake.db), SHOP) };
}

describe('BundleItemRepository', () => {
  it('scopes listForBundle by shop as well as bundle, ordered by name', async () => {
    const { fake, items } = repo();
    await items.listForBundle('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"bundle_id" = \?/i);
    expect(sql).toMatch(/order by .*"name"/i);
    expect(params).toEqual(expect.arrayContaining([SHOP, 'b1']));
  });

  it('orders findAll by name too, so the list route never re-sorts', async () => {
    const { fake, items } = repo();
    await items.findAll();

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/order by .*"name"/i);
    expect(params).toEqual([SHOP]);
  });

  it('scopes the sum and multiplies price by qty', async () => {
    const { fake, items } = repo([{ total: 3999 }]);
    await items.sumFor('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/sum\("bundle_item"\."price" \* "bundle_item"\."qty"\)/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toEqual(expect.arrayContaining([SHOP, 'b1']));
  });

  it('groups sumsByBundle so the list page is not N+1', async () => {
    const { fake, items } = repo([{ bundleId: 'b1', total: 3999 }]);
    const sums = await items.sumsByBundle();

    expect(fake.lastQuery().sql).toMatch(/group by "bundle_item"\."bundle_id"/i);
    expect(sums.get('b1')).toBe(3999);
  });

  it('injects the shop on insert regardless of what the caller passed', async () => {
    const { fake, items } = repo([{ id: 'i1' }]);
    await items.create({
      bundleId: 'b1', variantId: 'gid://shopify/ProductVariant/1',
      name: 'Blue T-Shirt / Large', qty: 2, price: 1500,
      ...({ shopId: OTHER } as unknown as Record<string, never>),
    });

    const { params } = fake.lastQuery();
    expect(params).toContain(SHOP);
    expect(params).not.toContain(OTHER);
  });

  it('replaceForBundle deletes the old rows and inserts the new ones', async () => {
    const { fake, items } = repo([]);
    await items.replaceForBundle('b1', [
      { variantId: 'gid://shopify/ProductVariant/1', name: 'A', qty: 1, price: 100 },
      { variantId: 'gid://shopify/ProductVariant/2', name: 'B', qty: 2, price: 200 },
    ]);

    const kinds = fake.queries.map((q) => q.sql.trim().split(/\s+/)[0].toLowerCase());
    expect(kinds[0]).toBe('delete');
    expect(kinds.filter((k) => k === 'insert')).toHaveLength(2);
    // Every statement is shop-scoped or carries the shop as a bound value.
    for (const q of fake.queries) expect(q.params).toContain(SHOP);
  });

  it('replaceForBundle with no items still clears the old ones', async () => {
    const { fake, items } = repo([]);
    await items.replaceForBundle('b1', []);

    expect(fake.queries).toHaveLength(1);
    expect(fake.lastQuery().sql).toMatch(/^delete/i);
  });
});
