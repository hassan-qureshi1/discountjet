# src/ — Backend (Cloudflare Worker)

Context for working in this directory. The Worker is a single Hono application exposed via the default `fetch` export. See root `CLAUDE.md` for project-wide rules.

---

## Commands

```bash
npm run dev                                         # Whole app (Vite + Worker) on http://localhost:5173
npm test                                            # Vitest
npm run test:e2e                                    # Playwright e2e smoke tests
npm run d1:generate                                 # Regenerate migration from schema changes
npm run d1:migrate                                  # Apply migrations to D1 (remote)
npm run d1:migrate:local                            # Apply migrations to D1 (local)
npm run deploy                                      # Build frontend + Worker, then deploy
```

### Secrets

```bash
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_API_SECRET
npx wrangler secret put HOST
```

---

## Worker Entry (`src/index.ts`)

Single `fetch` export — all Hono routes. To add Queues, Durable Objects, or cron triggers, uncomment the matching block in `wrangler.jsonc` and add the corresponding export to `src/index.ts` (`queue`, `scheduled`).

---

## Request Auth

All `/api/*` routes are guarded by `src/middleware/requireShop.ts`. That middleware resolves the shop row **once** per request and stashes three things on the context:

- `c.get('shopId')` — the app-internal id
- `requireShopDomain(c)` (`src/lib/shopDomain.ts`) — the `*.myshopify.com` domain, for Admin API calls. Reads the context, issues no query, and throws if the row has no domain.
- `c.get('repos')` — every repository, already bound to this shop.

Never call `getCurrentShop()` directly, and never re-select the shop row just to get its domain.

To make a route public, add it to `PUBLIC_API_PATHS` in `requireShop.ts` with a comment. A
public route gets **no** `repos`: shop-scoped repositories cannot be constructed without a
tenant, and there is no tenant before auth.

---

## Database

- `src/db/schema.ts` — Drizzle tables
- `src/db/db.ts` — `createDb(d1)` factory. Called only from `src/db/repositories/`
- `src/db/repositories/` — the only place Drizzle queries are written
- `src/db/repositories/inMemory.ts` — in-memory implementations of the same interfaces, **test-only** (nothing in the Worker imports it)
- `src/db/repositories/testing/fakeD1.ts` — recording fake D1 for repository-level tests
- `src/db/repositories/_example.repository.ts` — annotated skeleton to copy when adding a table
- `docs/erd.dbml` — the ERD, in dbdiagram.io (DBML) format
- Use Drizzle ORM — never raw SQL strings outside migrations

**`docs/erd.dbml` is part of the schema change, not a follow-up.** Any edit to
`schema.ts` — a new table, a new or renamed column, a changed enum, a new index or
FK — updates the ERD in the same commit, after the DB design has been approved.
`schema.ts` stays the source of truth; the ERD is a hand-maintained mirror, so the
two drifting apart makes the diagram actively misleading rather than merely stale.

### Repository layer

```
IRepository<TRow, TNew>              contract; no Drizzle types
  └ IShopScopedRepository            adds readonly shopId

BaseRepository                       abstract; generic Drizzle implementation
  ├ ShopScopedRepository             abstract; requires shopId, scopes every query
  │   ├ BundleRepository
  │   └ DiscountRepository
  └ ShopRepository                   shopify_shop — it IS the tenant, so unscoped

WebhookEventRepository               outside the hierarchy on purpose — see its class comment
```

`BaseRepository.create()` mints `crypto.randomUUID()` ids and ISO-8601 timestamps, so the
project's two data rules cannot be got wrong by a new table. `ShopScopedRepository` composes
`shop_id = ?` into every read **and** write, and injects the shop on insert — a row belonging
to another shop reads as absent rather than being mutated. `shopId` is dropped from the write
type, so a caller trying to pass one for another shop does not compile.

### Adding a repository for a new table

See `src/db/repositories/_example.repository.ts` for the annotated version. In short:

1. Add the table to `schema.ts` with a non-null `shopId` FK (`onDelete: 'cascade'`),
   and update `docs/erd.dbml` in the same commit.
2. Extend `ShopScopedRepository` and add only the queries your domain needs:

```ts
export class BundleRepository extends ShopScopedRepository<typeof bundle> {
  constructor(db: Db, shopId: string) { super(db, bundle, shopId); }

  async listActive() {
    return this.db.select().from(bundle).where(this.scope(eq(bundle.status, 'Active')));
  }
}
```

   Always compose custom predicates through `this.scope(...)` — that is what keeps them scoped.
3. Register it in `src/db/repositories/index.ts` (`Repositories` + `createRepositoriesFromDb`)
   and add its fake to `inMemory.ts`.

### Using a repository

```ts
// In a route handler — requireShop already built these for the current shop.
const rows = await c.get('repos').bundles.findAll();

// Outside a request (lifecycle, webhooks, cron, queues):
const repos = createRepositories(env.DB, shopId);
const shops = createShopRepository(env.DB);   // when there is no shop id yet
```

Nothing outside `src/db/repositories/` passes a shop id to a query. If you find
yourself wanting to, the repository is missing a method.

### findById vs getById

`findById` returns `TRow | null` for the legitimately-absent case — map it to a 404.
`getById` throws `NotFoundError` where a missing row means corrupt state. Pick deliberately;
never mask a missing row with `?? ''` or a default.

### Escape hatches, and why they exist

Two places deliberately bypass the base class. Both are documented at the definition,
and neither is a precedent:

- `DiscountRepository.insertMirror` / `updateMirror` — `discount.createdAt`/`updatedAt`
  are copies of **Shopify's** timestamps, and the sync's ordering guard compares against
  them. `create()`/`update()` would stamp them with now and defeat the guard. Still scoped.
- `WebhookEventRepository` — outside the hierarchy entirely: nullable `shop_id` with no FK,
  an id that is Shopify's delivery id rather than a minted UUID, and a duplicate gate that
  must fire before a shop has been resolved at all.

### Other rules

- **Never** hold a repository or `Db` at module scope. A Worker isolate is reused across
  requests from different shops, so a shared client is how a cross-tenant bug gets in.
- Return `null`, never `undefined`, for a miss — Drizzle's `.get()` yields `undefined`, and
  normalising once stops every call site from guessing which to check.
- Repositories stay dumb: no Hono context, no status codes, no Admin API calls, no business rules.

### Testing

Repository tests use the recording fake D1 in `src/db/repositories/testing/fakeD1.ts` and
assert on the SQL and bindings Drizzle emits — that is how the scoping guarantee is proven
without a real database (`ShopScopedRepository.test.ts`). Route and middleware tests inject
the in-memory fakes (`createInMemoryRepositories(shopId, seed)`) and assert on the rows left
behind; never mock the Drizzle query builder.

---

## Local Testing

```bash
# Apply migrations
wrangler d1 migrations apply cloudflare-shopify-starter-db --local

# Insert a test shop
wrangler d1 execute cloudflare-shopify-starter-db --local --command "
  INSERT OR IGNORE INTO shopify_shop (id, myshopify_domain, domain, name, status, install_date)
  VALUES ('test-shop-id', 'mystore.myshopify.com', 'mystore.myshopify.com', 'Test Store', 'installed', datetime('now'));
"

# Hit the example endpoint (header-fallback auth in local dev)
curl http://localhost:8787/api/example -H "x-shop-domain: mystore.myshopify.com"
```
