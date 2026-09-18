// ─────────────────────────────────────────────────────────────────────────────
// REPOSITORY SKELETON — copy this file when you add a new table.
//
// Rename it to `<table>Repo.ts` (e.g. `campaignRepo.ts`), swap the example
// table for your real one from `../schema`, and delete every comment marked
// `[SKELETON]` once you've read it.
//
// This file is not imported anywhere. It compiles so you get real type errors
// while you work, but it ships in no bundle and runs in no test.
//
// THE ONE RULE: every SQL query in this app lives in `src/db/repos/`. Route
// handlers, webhooks and lifecycle code call these methods — they never build
// a Drizzle query themselves. If you find yourself writing `db.select()` in a
// route, that query belongs here instead.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq, isNull } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db';
import { shopifyShop } from '../schema';

// ─── [SKELETON] Example table ────────────────────────────────────────────────
//
// DELETE THIS BLOCK. It exists only so this file type-checks on its own. Your
// real table belongs in `src/db/schema.ts` (with a generated migration —
// `npm run d1:generate`), and you import it here:
//
//     import { campaign } from '../schema';
//
// It is reproduced here because it shows the three conventions every table in
// this app follows, and the junior-visible reasons for them:
//
//   1. `id` is a text primary key holding a `crypto.randomUUID()`. Not an
//      auto-increment integer — D1 is replicated and ids are generated in the
//      Worker, before any insert, so there is no sequence to rely on.
//   2. Every table carries a NON-NULL `shopId` FK to `shopify_shop` with
//      `onDelete: 'cascade'`. That cascade IS the GDPR `SHOP_REDACT`
//      implementation — deleting the shop row erases the merchant's data
//      everywhere. A nullable `shopId` would survive that delete, so it is a
//      compliance bug, not a style preference.
//   3. Timestamps are ISO 8601 strings in `text()` columns. SQLite has no
//      datetime type, and ISO strings sort lexicographically, so the ordering
//      guards elsewhere in this app (see `discountSync.ts`) compare them with
//      plain `<`.
//
const widget = sqliteTable(
  'widget',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shopifyShop.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    // Money is stored in CENTS as an integer. Never store a float — 0.1 + 0.2
    // is not 0.3, and a rounding drift in a discount is a merchant refund.
    // Convert to dollars at the route boundary, not here.
    priceCents: integer('price_cents'),
    // Tombstone. A row with `deletedAt` set is soft-deleted: still on disk,
    // excluded from every read. See `listLive` below.
    deletedAt: text('deleted_at'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    shopIdIdx: index('widget_shop_id_idx').on(t.shopId),
  }),
);
// ─── end of block to delete ──────────────────────────────────────────────────

/**
 * The row as it comes OUT of a select. Always derive these from the table
 * rather than hand-writing an interface — then a schema change breaks the
 * build here instead of failing silently at runtime.
 */
export type WidgetRow = typeof widget.$inferSelect;

/**
 * The row as it goes IN to an insert: columns with defaults are optional.
 * `$inferSelect` and `$inferInsert` are different types; using the wrong one
 * is the most common mistake when writing a repo.
 */
export type WidgetInsert = typeof widget.$inferInsert;

/**
 * The contract a handler depends on. Declare it, add `widgets` to `Repos` in
 * `./index.ts`, and handlers reach it as `c.get('repos').widgets` — they never
 * name the class. That indirection is what lets a test pass an in-memory
 * implementation instead (see `inMemory.ts`), so tests assert on the rows a
 * request leaves behind rather than on stubbed Drizzle calls.
 */
export interface WidgetStore {
  listLive(shopId: string): Promise<WidgetRow[]>;
  find(shopId: string, id: string): Promise<WidgetRow | null>;
  insert(row: WidgetInsert): Promise<void>;
  update(shopId: string, id: string, patch: Partial<WidgetRow>): Promise<void>;
  tombstone(shopId: string, id: string, deletedAt: string): Promise<void>;
  delete(shopId: string, id: string): Promise<void>;
}

/**
 * The D1-backed `WidgetStore`.
 *
 * `implements` is load-bearing: the compiler checks this class against the
 * contract, and the in-memory fake against the same one, so the two can never
 * drift apart. A handler gets it off the context:
 *
 *     const widgets = c.get('repos').widgets;
 *     const row = await widgets.find(c.get('shopId'), c.req.param('id'));
 *
 * `createDb` is NOT a database connection — there is no handshake and no pool,
 * it is a thin object over the D1 binding — so constructing a repository per
 * request costs nothing. Do not cache one in a module-level variable: a Worker
 * isolate is reused across requests from different shops, and a shared client
 * is how a cross-tenant bug gets introduced.
 */
export class WidgetRepository implements WidgetStore {
  constructor(private readonly db: Db) {}

  /**
   * The tenant boundary, in ONE place.
   *
   * Every row-scoped query filters on `shopId` as well as `id` — an id alone
   * is guessable and would let shop A read or overwrite shop B's row. Writing
   * that pair out at each call site means one forgotten clause is a data leak,
   * so it lives here and nothing bypasses it.
   *
   * If you add a method that takes an `id`, it uses this helper. No exceptions.
   */
  private scoped(shopId: string, id: string) {
    return and(eq(widget.id, id), eq(widget.shopId, shopId));
  }

  /**
   * All of a shop's live rows.
   *
   * Note this filters out tombstoned rows rather than leaving that to the
   * caller — a soft-deleted row leaking into a list is the bug soft deletes
   * usually cause. If you need the tombstoned ones (a reconcile pass might),
   * add a separate, explicitly-named method for it.
   */
  async listLive(shopId: string): Promise<WidgetRow[]> {
    return this.db
      .select()
      .from(widget)
      .where(and(eq(widget.shopId, shopId), isNull(widget.deletedAt)))
      .all();
  }

  /**
   * One row, or null when it does not exist / belongs to another shop. Those
   * two cases are deliberately indistinguishable to the caller: telling an
   * attacker "this id exists, just not for you" leaks the row's existence.
   *
   * Returns `null`, never `undefined` — Drizzle's `.get()` gives `undefined`
   * for a miss, and a repo that returns both makes every call site guess which
   * to check. Normalise it here, once.
   */
  async find(shopId: string, id: string): Promise<WidgetRow | null> {
    const row = await this.db.select().from(widget).where(this.scoped(shopId, id)).get();
    return row ?? null;
  }

  /**
   * Insert. The caller builds the whole row (including `id` and timestamps) so
   * it can return the created object without a second read.
   */
  async insert(row: WidgetInsert): Promise<void> {
    await this.db.insert(widget).values(row);
  }

  /**
   * Partial update, tenant-scoped.
   *
   * `Partial<WidgetRow>` keeps the caller honest about column names while
   * letting it send only what changed. A no-op update (empty patch) is the
   * caller's bug to avoid — always pass at least `updatedAt`.
   */
  async update(shopId: string, id: string, patch: Partial<WidgetRow>): Promise<void> {
    await this.db.update(widget).set(patch).where(this.scoped(shopId, id));
  }

  /**
   * Prefer a NARROW, named method over a general `update` when the app writes
   * the same couple of fields at several call sites — the name documents the
   * intent, and the signature stops a caller from setting the pair to an
   * inconsistent combination.
   *
   * (Compare `BundleRepository.setMetafieldState`, which exists for exactly
   * this reason: `metafieldGid` is meaningless unless `metafieldState` agrees.)
   */
  async tombstone(shopId: string, id: string, deletedAt: string): Promise<void> {
    await this.db.update(widget).set({ deletedAt }).where(this.scoped(shopId, id));
  }

  /** Hard delete. Prefer `tombstone` unless the row genuinely must vanish. */
  async delete(shopId: string, id: string): Promise<void> {
    await this.db.delete(widget).where(this.scoped(shopId, id));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [SKELETON] The in-memory twin.
//
// For a real table this class goes in `./inMemory.ts` (test-only, imported by
// nothing in the Worker). It is shown here so you can see the pair together.
//
// It exists so tests can seed rows, drive a real HTTP request through the Hono
// app, and then assert on the rows the request left behind — instead of
// stubbing a Drizzle query chain and asserting that some query was issued.
// The difference matters: a stub test breaks when a handler changes HOW it
// queries, even if its behaviour is identical. A test against this fake only
// breaks when the behaviour actually changes.
//
// `implements WidgetStore` is what keeps the fake honest. Add a method to the
// interface and this class stops compiling until it gains the method too, so
// the fake can never quietly diverge from what the real repository does.
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryWidgetStore implements WidgetStore {
  // `public` so a test can read the rows back: `repos.widgets.rows[0]`.
  constructor(public rows: WidgetRow[] = []) {}

  // Mirror the repository's tenant scoping rather than matching on id alone.
  // If the fake were laxer than the real thing, a handler that forgot its
  // `shopId` filter would pass its tests and leak data in production.
  private index(shopId: string, id: string): number {
    return this.rows.findIndex((r) => r.id === id && r.shopId === shopId);
  }

  async listLive(shopId: string): Promise<WidgetRow[]> {
    return this.rows.filter((r) => r.shopId === shopId && r.deletedAt === null);
  }

  async find(shopId: string, id: string): Promise<WidgetRow | null> {
    const i = this.index(shopId, id);
    // Return a COPY. Handing out the stored object lets a handler mutate the
    // store by accident, which D1 would never do — the fake would be hiding
    // a bug instead of exposing it.
    return i === -1 ? null : { ...this.rows[i] };
  }

  async insert(row: WidgetInsert): Promise<void> {
    this.rows.push({ ...row } as WidgetRow);
  }

  async update(shopId: string, id: string, patch: Partial<WidgetRow>): Promise<void> {
    const i = this.index(shopId, id);
    // A miss is a silent no-op, exactly as `UPDATE ... WHERE` matching no row
    // is. Do not throw here — that would make the fake stricter than D1.
    if (i !== -1) this.rows[i] = { ...this.rows[i], ...patch };
  }

  async tombstone(shopId: string, id: string, deletedAt: string): Promise<void> {
    await this.update(shopId, id, { deletedAt });
  }

  async delete(shopId: string, id: string): Promise<void> {
    const i = this.index(shopId, id);
    if (i !== -1) this.rows.splice(i, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [SKELETON] How a test uses it, end to end
//
//   it('POST /api/widgets stores the row against the caller\'s shop', async () => {
//     const repos = seed();                       // installs the fakes
//     const res = await app.request('/api/widgets', { method: 'POST', ... });
//
//     expect(res.status).toBe(201);
//     // Assert on STATE, not on which queries ran.
//     expect(repos.widgets.rows).toHaveLength(1);
//     expect(repos.widgets.rows[0]).toMatchObject({ shopId: SHOP.id, name: 'Thing' });
//   });
//
// See `src/api.integration.test.ts` for the real `seed()` helper. To simulate
// a failure the fake cannot naturally reach (a row vanishing mid-request, a
// store throwing), override the one method on the instance:
//
//     repos.widgets.find = async () => null;
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// [SKELETON] What does NOT belong in a repository
//
//   • HTTP concerns. No `c.json(...)`, no status codes, no Hono context. A
//     repo returns data or null; the route decides what a null means (404?
//     empty list? create-on-demand?).
//   • Shopify Admin API calls. Those live in `src/lib/`. A method that both
//     writes a row and calls Shopify hides a partial-failure path — the route
//     orchestrates the two so the failure is visible and handled.
//   • Business rules. "An expand bundle needs at least one item" is a route
//     validation, not a query. Repos stay dumb about what the data means.
//   • Silent fallbacks. Never `?? ''` a missing domain or id to keep a query
//     running. If required data is absent that is a data-integrity bug — let
//     it surface (see `requireShopDomain` in `src/lib/shopDomain.ts` for the
//     house style: throw with the id in the message).
//
// Once the repository exists, wire it up in two more places:
//   1. `./index.ts`    — add `widgets: WidgetStore` to `Repos` and construct it
//      in `createRepos`, so handlers reach it off the request context.
//   2. `./inMemory.ts` — add `InMemoryWidgetStore implements WidgetStore` and a
//      `widgets` entry in `createInMemoryRepos`, so tests can seed it.
//
// Related reading, in rough order of usefulness:
//   • `src/db/repos/bundleRepo.ts`   — `BundleRepository`, the closest analogue
//   • `src/db/repos/inMemory.ts`     — the fakes, and how tests seed them
//   • `src/db/repos/shopRepo.ts`     — projections, upserts, install/uninstall
//   • `src/CLAUDE.md`                — the backend conventions this follows
// ─────────────────────────────────────────────────────────────────────────────
