import { and, asc, eq } from 'drizzle-orm';
import { template } from '../schema';
import type { Db } from './BaseRepository';

export type TemplateRow = typeof template.$inferSelect;

export interface TemplateSeed {
  slug: string;
  name: string;
  description: string;
  example?: string;
  category: string;
  symbol?: string;
  type: TemplateRow['type'];
  /** Already-serialised JSON of the partial form data. */
  defaults: string;
  sortOrder: number;
  active?: number;
}

export interface ITemplateRepository {
  listActive(): Promise<TemplateRow[]>;
  findBySlug(slug: string): Promise<TemplateRow | null>;
  upsertMany(seeds: TemplateSeed[]): Promise<void>;
}

/**
 * Promotion templates.
 *
 * DELIBERATELY OUTSIDE the BaseRepository/ShopScopedRepository hierarchy, and
 * the second table in this app with no tenant, after `webhook_event`.
 *
 * `template` rows are curated content: identical for every shop, carrying no
 * merchant data, with nothing to cascade on SHOP_REDACT. Extending
 * `ShopScopedRepository` would require a `shopId` this table does not have, and
 * would advertise an isolation guarantee that protects nothing here.
 *
 * Reads are filtered on `active = 1` rather than exposing a flag, so a retired
 * template cannot be resurrected by whoever still has the URL.
 */
export class TemplateRepository implements ITemplateRepository {
  constructor(private readonly db: Db) {}

  async listActive(): Promise<TemplateRow[]> {
    return this.db
      .select()
      .from(template)
      .where(eq(template.active, 1))
      .orderBy(asc(template.sortOrder), asc(template.name))
      .all();
  }

  async findBySlug(slug: string): Promise<TemplateRow | null> {
    const row = await this.db
      .select()
      .from(template)
      .where(and(eq(template.slug, slug), eq(template.active, 1)))
      .get();
    // Drizzle's `.get()` yields undefined; normalise once so no call site guesses.
    return row ?? null;
  }

  /**
   * Idempotent seed, keyed by slug. Re-running is a no-op beyond refreshing
   * copy, which is what lets install re-seed on every install without
   * duplicating rows or needing a migration when wording changes.
   */
  async upsertMany(seeds: TemplateSeed[]): Promise<void> {
    const now = new Date().toISOString();
    for (const seed of seeds) {
      const existing = await this.db
        .select({ id: template.id })
        .from(template)
        .where(eq(template.slug, seed.slug))
        .get();

      if (existing) {
        await this.db
          .update(template)
          .set({
            name: seed.name,
            description: seed.description,
            example: seed.example ?? null,
            category: seed.category,
            symbol: seed.symbol ?? null,
            type: seed.type,
            defaults: seed.defaults,
            sortOrder: seed.sortOrder,
            active: seed.active ?? 1,
            updatedAt: now,
          })
          .where(eq(template.slug, seed.slug));
      } else {
        await this.db.insert(template).values({
          id: crypto.randomUUID(),
          slug: seed.slug,
          name: seed.name,
          description: seed.description,
          example: seed.example ?? null,
          category: seed.category,
          symbol: seed.symbol ?? null,
          type: seed.type,
          defaults: seed.defaults,
          sortOrder: seed.sortOrder,
          active: seed.active ?? 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
}
