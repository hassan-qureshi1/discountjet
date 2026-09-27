import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import type { TemplateRow } from '../db/repositories';

export const templateRoutes = new Hono<AppEnv>();

interface TemplateDto {
  slug: string;
  name: string;
  description: string;
  example: string | null;
  category: string;
  symbol: string | null;
  type: TemplateRow['type'];
  /** Parsed, not a string — the client should not re-parse what we stored. */
  defaults: unknown;
}

/**
 * `defaults` is our own JSON, written by the seed catalogue, so a parse failure
 * means a corrupt row rather than bad user input. Throwing surfaces it as a 500
 * with the slug rather than handing the client a template whose form cannot be
 * built.
 */
function toDto(row: TemplateRow): TemplateDto {
  let defaults: unknown;
  try {
    defaults = JSON.parse(row.defaults);
  } catch (err) {
    throw new Error(`[templates] template '${row.slug}' has unparseable defaults: ${String(err)}`);
  }
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    example: row.example,
    category: row.category,
    symbol: row.symbol,
    type: row.type,
    defaults,
  };
}

templateRoutes.get('/api/templates', async (c) => {
  const rows = await c.get('repos').templates.listActive();
  return c.json({ templates: rows.map(toDto) });
});

templateRoutes.get('/api/templates/:slug', async (c) => {
  const row = await c.get('repos').templates.findBySlug(c.req.param('slug'));
  // `findBySlug` already filters on active, so a retired template is absent
  // rather than served — see TemplateRepository.
  if (!row) return c.json({ error: 'Template not found' }, 404);
  return c.json({ template: toDto(row) });
});
