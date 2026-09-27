import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { TemplateRepository } from './TemplateRepository';
import { createFakeD1 } from './testing/fakeD1';

function repo(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  return { fake, repo: new TemplateRepository(createDb(fake.db)) };
}

describe('TemplateRepository', () => {
  it('lists only active templates, ordered', async () => {
    const { fake, repo: r } = repo();
    await r.listActive();

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^select/i);
    expect(sql).toMatch(/"active" = \?/i);
    expect(sql).toMatch(/order by/i);
    expect(params).toContain(1);
  });

  it('finds by slug', async () => {
    const { fake, repo: r } = repo();
    await r.findBySlug('pct-off');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"slug" = \?/i);
    expect(params).toContain('pct-off');
  });

  // Review Focus #3 — a retired template must not keep working just because
  // someone kept the URL.
  it('does not return an inactive row from findBySlug', async () => {
    const { fake, repo: r } = repo();
    await r.findBySlug('retired');
    expect(fake.lastQuery().sql).toMatch(/"active" = \?/i);
  });

  it('returns null, never undefined, for a miss', async () => {
    const { repo: r } = repo([]);
    await expect(r.findBySlug('nope')).resolves.toBeNull();
  });

  it('is unscoped by design — it never binds a shop id', async () => {
    const { fake, repo: r } = repo();
    await r.listActive();
    expect(fake.lastQuery().sql).not.toMatch(/"shop_id"/i);
  });
});
