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

All `/api/*` routes are guarded by `src/middleware/requireShop.ts`. That middleware resolves the shop row **once** per request and stashes both fields on the context:

- `c.get('shopId')` — the app-internal id
- `requireShopDomain(c)` (`src/lib/shopDomain.ts`) — the `*.myshopify.com` domain, for Admin API calls. Reads the context, issues no query, and throws if the row has no domain.

Never call `getCurrentShop()` directly, and never re-select the shop row just to get its domain.

To make a route public, add it to `PUBLIC_API_PATHS` in `requireShop.ts` with a comment.

---

## Database

- `src/db/schema.ts` — Drizzle tables
- `src/db/db.ts` — `createDb(d1)` factory. Not a connection (no handshake, no pool), so calling it once per handler is free; pass the client down rather than re-deriving it.
- `src/db/repos/` — **every** query lives here. Each table has a store *interface* (`ShopStore`, `BundleStore`, …) and a D1-backed class implementing it (`ShopRepository`, `BundleRepository`, …). Handlers and lifecycle code call these methods; they never build Drizzle queries themselves.
- `src/db/repos/index.ts` — `createRepos(db)` builds the whole set; `Repos` is the interface bundle handlers see.
- `src/db/repos/inMemory.ts` — in-memory implementations of the same interfaces, **test-only** (nothing in the Worker imports it).
- `src/db/repos/_example.repository.ts` — annotated skeleton to copy when adding a table.
- Use Drizzle ORM — never raw SQL strings outside migrations

**Repository rules**

- Handlers take stores off the context — `const bundleRepo = c.get('repos').bundles;` — and never construct one. `requireShop` builds the set once per request via `createRepos(createDb(c.env.DB))`.
- That single seam is what tests replace: they mock `createRepos` and hand back `createInMemoryRepos({ ... })`, then assert on the rows left in the fakes. No test stubs a Drizzle query chain, so handlers can change how many queries they run without breaking tests.
- Code outside the request path (lifecycle hooks, webhooks, `discountSync`) constructs repositories directly from a `Db`, since it has no Hono context.
- **Never** hold a repository or `Db` at module scope. A Worker isolate is reused across requests from different shops, so a shared client is how a cross-tenant bug gets in.
- Shop-scoped reads/writes filter on `shopId` **inside** the repository (see the private `scoped()` in `BundleRepository`). That pairing is the tenant boundary; keeping it in one place means a handler cannot leak another shop's row by forgetting a clause.
- Return `null`, never `undefined`, for a miss — Drizzle's `.get()` yields `undefined`, and normalising once stops every call site from guessing which to check.
- Repositories stay dumb: no Hono context, no status codes, no Admin API calls, no business rules.

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
