# Local Development

How to run, test, and review Discount Jet locally. The app is a single Cloudflare
Worker (Hono) that serves the React frontend and the `/api/*` + Shopify OAuth/webhook
routes, with **D1** (SQLite), **KV** (Shopify sessions), and **R2** bound locally.

> TL;DR
> ```bash
> npm install
> cp .dev.vars.example .dev.vars      # fill in Shopify credentials
> npm run setup                        # apply D1 migrations to the LOCAL db
> npm run dev                          # http://localhost:5173  (Worker + frontend)
> npm run dev:tunnel                   # (separate terminal) HTTPS tunnel for OAuth/webhooks
> ```

---

## 1. Prerequisites

- **Node 20+** and npm
- **Wrangler** (installed via devDependencies; `npx wrangler …`)
- **Shopify Partner account** + a **development store**
- **Shopify CLI** (`shopify`) — only needed for the `shopify app dev` path and for
  building the Function/UI extensions
- **cloudflared** — for the manual-tunnel path (`brew install cloudflared`)

---

## 2. Environment & secrets

Local dev reads secrets from **`.dev.vars`** (loaded by the Cloudflare Vite plugin —
you do **not** run `wrangler secret put` locally). Copy the template and fill it in:

```bash
cp .dev.vars.example .dev.vars
```

| Key | Value |
|---|---|
| `SHOPIFY_CLIENT_ID` | `29769b19e8565a72d5e08c9f61ed4c44` (from `shopify.app.discount-engine-dev.toml`) |
| `SHOPIFY_API_SECRET` | Partner Dashboard → your app → **App setup** → Client secret |
| `ENVIRONMENT` | `development` — enables the dev `x-shop-domain` auth fallback (see §6) |
| `HOST` | your tunnel hostname, **no `https://`** (set after you start the tunnel, §5) |

> `.dev.vars` and `.env` are git-ignored — never commit credentials.

---

## 3. Cloudflare resources (local vs remote)

For **local** dev the Vite plugin runs the Worker in the real `workerd` runtime with
**local** D1/KV/R2 (stored under `.wrangler/state/`), so you don't need real
Cloudflare resources to develop. The `database_id` / KV `id` placeholders in
`wrangler.jsonc` are only used for **remote** (`--remote` / deploy).

Apply migrations to the local DB (creates `shopify_shop`, `discount`, `webhook_event`):

```bash
npm run setup                 # = wrangler d1 migrations apply … --local
```

Regenerate a migration after editing `src/db/schema.ts`:

```bash
npm run d1:generate           # drizzle-kit generate  → drizzle/migrations/
npm run d1:migrate:local      # apply locally
```

---

## 4. Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Worker + local D1/KV/R2 on **http://localhost:5173** |
| `npm run dev:tunnel` | `cloudflared tunnel --url http://localhost:5173` (HTTPS tunnel) |
| `npm run setup` | Apply D1 migrations to the **local** DB |
| `npm run d1:migrate` / `:local` | Apply migrations to **remote** / local D1 |
| `npm run d1:generate` | Generate a migration from schema changes |
| `npm test` | Vitest unit tests |
| `npm run type-check` | `tsc --noEmit` |
| `npm run check` | Typecheck + build + `wrangler deploy --dry-run` |
| `npm run deploy` | Build + apply remote migrations + deploy |

---

## 5. Two ways to run against Shopify

Shopify must reach your local Worker over **HTTPS** for OAuth and the `discounts/*`
webhooks. Pick one:

### Path A — `shopify app dev` (recommended for the full flow)

Handles the tunnel, auto-updates the app URLs, and **serves the Function + UI
extensions** — required to actually create app-owned discounts that E4 mirrors.

```bash
shopify app dev
```

Follow the prompt to install on your dev store. URLs update automatically.

### Path B — cloudflared tunnel (Worker/webhooks only)

```bash
# terminal 1
npm run dev
# terminal 2
npm run dev:tunnel        # prints https://<random>.trycloudflare.com
```

Then:
1. Put `HOST=<random>.trycloudflare.com` in `.dev.vars` (host only — webhooks register
   as `https://${HOST}/shopify/webhooks`).
2. In **Partner Dashboard → App setup** (or edit the dev `.toml` and
   `shopify app config push`) set:
   - **App URL:** `https://<random>.trycloudflare.com`
   - **Redirect URL:** `https://<random>.trycloudflare.com/api/auth`
3. Restart `npm run dev` so it picks up the new `HOST`.

> ⚠️ `trycloudflare` URLs change on every restart — you must re-update `HOST` + the app
> URLs each time (and re-install or reconcile). This is why Path A is easier.
> Path B alone runs only the Worker, not the extensions, so you can exercise
> webhooks/APIs/reconcile but can't create app-owned discounts.

---

## 6. What happens on install

`GET /shopify/install` → (iframe-escape if needed) → `shopify.auth.begin()` → consent →
`GET /shopify/callback`:

1. Exchanges the code for an **offline** token; stores the session in **KV**.
2. Upserts the `shopify_shop` row (`status: 'installed'`).
3. `onShopInstall`:
   - hydrates shop details from `shop.json`,
   - **registers webhooks**: `app/uninstalled` + `discounts/create|update|delete`,
   - **backfills** existing **app-owned** discounts into the `discount` mirror
     (best-effort; recoverable via `POST /api/discounts/reconcile`).

After install, any discount change fires a `discounts/*` webhook →
`/shopify/webhooks` → HMAC verify → upsert/tombstone in D1. Native discounts are not
mirrored (they show live in `/api/shopify-discounts`).

---

## 7. Reviewing / testing without a store

The dev auth fallback lets you call protected routes with a header when
`ENVIRONMENT=development`:

```bash
npm run setup                        # ensure local tables exist

# seed a shop + a sample synced discount
npx wrangler d1 execute cloudflare-shopify-starter-db --local --command "
  INSERT OR IGNORE INTO shopify_shop (id,myshopify_domain,domain,name,status,install_date)
  VALUES ('test-shop-id','mystore.myshopify.com','mystore.myshopify.com','Test Store','installed',datetime('now'));
  INSERT OR IGNORE INTO discount (id,shop_id,shopify_gid,name,type,method,status,products,created_at,updated_at)
  VALUES ('rev-1','test-shop-id','gid://shopify/DiscountNode/999','Buy 3 pillows save 15%','tier','automatic','active',4,datetime('now'),datetime('now'));"

npm run dev                          # then, in another terminal:
H='x-shop-domain: mystore.myshopify.com'
curl -s localhost:5173/api/discounts             -H "$H"   # list + per-tab counts
curl -s localhost:5173/api/discounts/rev-1       -H "$H"   # detail
curl -s localhost:5173/api/discounts/sync-health -H "$H"   # last webhook / reconcile / unknownCount
```

- `GET /api/shopify-discounts` and `POST /api/discounts/reconcile` call **live** Admin
  GraphQL, so they need an installed store's token — expect errors locally without one.
- Inspect the DB directly:
  ```bash
  npx wrangler d1 execute cloudflare-shopify-starter-db --local \
    --command "SELECT id,name,type,status,products,deleted_at FROM discount;"
  npx wrangler d1 execute cloudflare-shopify-starter-db --local \
    --command "SELECT topic,received_at FROM webhook_event ORDER BY received_at DESC;"
  ```

### Endpoints

| Route | Notes |
|---|---|
| `GET /health` | Public health check |
| `GET /api/discounts?status=all\|tier\|bundle\|special\|inactive` | List + per-tab counts (D1) |
| `GET /api/discounts/:id` | Detail; 404 if missing/tombstoned |
| `GET /api/discounts/sync-health` | last webhook / last reconcile / unknown-config count |
| `POST /api/discounts/reconcile` | Re-sync + tombstone deleted-while-offline (live GraphQL) |
| `GET /api/shopify-discounts` | Native + app discounts, live (live GraphQL) |
| `GET /shopify/install` · `/shopify/callback` | OAuth |
| `POST /shopify/webhooks` | HMAC-verified webhook sink |

---

## 8. Troubleshooting

- **401 on `/api/*` locally** — set `ENVIRONMENT=development` in `.dev.vars` and pass
  `-H 'x-shop-domain: <domain>'`, or install through the tunnel for a real session.
- **Webhooks never arrive** — `HOST` is wrong/stale; it must equal the current tunnel
  host. Re-set it, restart `npm run dev`, then re-install or `POST …/reconcile`.
- **`/discounts` is empty after install** — only **app-owned** discounts are mirrored.
  Create one via the extension UI (Path A), or run `POST /api/discounts/reconcile`.
- **`reconcile` / `shopify-discounts` error locally** — no stored token; these need an
  installed store (Path A or B), not just the dev header.
- **Migration not applied** — run `npm run setup` (local) or `npm run d1:migrate`
  (remote) before hitting the discount routes.
