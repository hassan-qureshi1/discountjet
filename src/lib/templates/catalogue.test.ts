import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATALOGUE } from './catalogue';
import { getAdapter } from '../discountEngines/adapters';

describe('TEMPLATE_CATALOGUE', () => {
  it('has unique slugs — the slug is the route key', () => {
    const slugs = TEMPLATE_CATALOGUE.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every template names an engine that exists', () => {
    for (const t of TEMPLATE_CATALOGUE) {
      expect(() => getAdapter(t.type)).not.toThrow();
    }
  });

  it('every template ships parseable defaults', () => {
    for (const t of TEMPLATE_CATALOGUE) {
      expect(() => JSON.parse(t.defaults)).not.toThrow();
    }
  });

  it('ships the three tier templates Stage 1 covers', () => {
    expect(TEMPLATE_CATALOGUE.map((t) => t.slug).sort())
      .toEqual(['buy-more', 'clearance', 'pct-off']);
    expect(TEMPLATE_CATALOGUE.every((t) => t.type === 'tier')).toBe(true);
  });
});
