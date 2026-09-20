// ─────────────────────────────────────────────────────────────────────────────
// Annotated skeleton — copy this when adding a table. Not imported anywhere;
// the leading underscore keeps it out of alphabetical listings of real
// repositories.
//
// The whole point of the layer is that this file is SHORT. Generic CRUD
// (findById / getById / findAll / create / update / delete), UUID ids, ISO-8601
// timestamps and `where shop_id = ?` all come from the base classes, so a new
// repository only writes the queries its own domain needs.
// ─────────────────────────────────────────────────────────────────────────────

/*

1. Add the table to `src/db/schema.ts` with a non-null `shopId` FK:

     export const widget = sqliteTable('widget', {
       id: text('id').primaryKey(),
       shopId: text('shop_id')
         .notNull()
         .references(() => shopifyShop.id, { onDelete: 'cascade' }),
       name: text('name').notNull(),
       createdAt: text('created_at').notNull(),
       updatedAt: text('updated_at').notNull(),
     });

2. Update `docs/erd.dbml` IN THE SAME CHANGE — see the root CLAUDE.md. The ERD
   is a hand-maintained mirror, so letting it drift makes it misleading rather
   than merely stale.

3. Generate the migration: `npm run d1:generate`.

4. Write the repository. This is the whole file:

     import { desc, eq } from 'drizzle-orm';
     import { widget } from '../schema';
     import { ShopScopedRepository } from './ShopScopedRepository';
     import type { Db } from './BaseRepository';
     import type { IShopScopedRepository } from './types';

     export type WidgetRow = typeof widget.$inferSelect;
     export type WidgetNew = Omit<typeof widget.$inferInsert, 'shopId'>;

     // Handlers name the interface, never the class — that is the seam the
     // in-memory fakes are injected through.
     export interface IWidgetRepository
       extends IShopScopedRepository<WidgetRow, WidgetNew> {
       listNewestFirst(): Promise<WidgetRow[]>;
     }

     export class WidgetRepository
       extends ShopScopedRepository<typeof widget>
       implements IWidgetRepository
     {
       constructor(db: Db, shopId: string) {
         super(db, widget, shopId);
       }

       // ALWAYS compose a custom predicate through `this.scope(...)`. That is
       // what keeps it scoped — a bare `.where(eq(...))` silently reaches
       // every shop's rows, and nothing else will catch it.
       async listNewestFirst(): Promise<WidgetRow[]> {
         return this.db
           .select()
           .from(widget)
           .where(this.scope())
           .orderBy(desc(widget.createdAt))
           .all();
       }
     }

5. Register it in `index.ts` — add the field to `Repositories` and construct it
   in `createRepositoriesFromDb`.

6. Add the fake to `inMemory.ts`: extend `InMemoryBase`, override `inScope` to
   filter on `shopId`, and implement `materialize`. `implements IWidgetRepository`
   is what makes the fake fail to compile if the interface grows a method.

7. Use it. In a handler:

     const widgets = await c.get('repos').widgets.listNewestFirst();

   Outside a request (lifecycle, webhooks, cron, queues), where there is no
   Hono context:

     const repos = createRepositories(env.DB, shopId);


── findById vs getById ───────────────────────────────────────────────────────

`findById` returns `TRow | null` for the legitimately-absent case — map it to a
404. `getById` throws `NotFoundError` where a missing row means corrupt state.
Pick deliberately; never mask a missing row with `?? ''` or a default.


── When NOT to extend ShopScopedRepository ───────────────────────────────────

Only when the table genuinely is not shop-owned. `shopify_shop` extends
`BaseRepository` because it IS the tenant, and `WebhookEventRepository` sits
outside the hierarchy entirely — read its class comment for the reasoning
before you decide your table is another exception. "It's easier" is not one.


── Testing ───────────────────────────────────────────────────────────────────

Repository tests use the recording fake D1 in `testing/fakeD1.ts` and assert on
the SQL and bindings Drizzle emits — that is how the scoping guarantee is
proven without a real database (see `ShopScopedRepository.test.ts`). Route and
middleware tests inject the in-memory fakes and assert on resulting state.
Never mock the Drizzle query builder.

*/

export {};
