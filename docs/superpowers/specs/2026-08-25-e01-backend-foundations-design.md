# E1 — Backend foundations & app setup

| | |
|---|---|
| **Date** | 2026-08-25 |
| **Status** | Draft spec |
| **Shopify plan** | All (Basic / Shopify / Advanced / Plus) |
| **App tier** | All (Starter / Growth / Scale) |
| **Depends on** | — (greenfield; builds on the `cloudflare-shopify-starter` template) |
| **Blocks** | E2 (function), E4 (sync), E6 (cart transform), E9 (cron), E11 (billing) — every downstream epic |

---

## Summary

Turn the untouched `cloudflare-shopify-starter` into the platform the discount engine needs, and make `discount-jet` the **single Shopify app** that houses everything: Cloudflare Worker backend + embedded React/Polaris admin UI + the Shopify Function and admin-UI extensions. Concretely, E1: sets OAuth scopes to match the extension app (`write_discounts`, `write_cart_transforms`, `read_products`, plus `read_orders` for analytics); adds `shopify.app.toml` and an `extensions/` directory and **migrates the `eva/discount-engine` extensions into `discount-jet/extensions/`** — the distribution model that makes Discount Jet a **public app** (which unlocks Shopify Functions on every merchant plan); stands up a typed cost-aware GraphQL Admin client on offline tokens (for programmatic paths only); lays the core D1 tables (`discount`, `discount_config`, `webhook_event`); and replaces the single inline `app/uninstalled` handler with idempotent, queue-backed webhook processing that includes the three mandatory GDPR topics and the `discounts/*` topics E4 consumes.

This epic ships no merchant-visible feature; it is the contract every other epic is built against.

### Relationship to `eva/discount-engine`

`eva/discount-engine` (`/Users/hassanahmed/code/eva/discount-engine`) is the working **extension app** and the **port source** — not a dependency and not a second app. Per the 2026-08-25 architecture decisions (master doc §1a), there is **ONE** app: `discount-jet`. E1 establishes `discount-jet/extensions/` as the single home for all extensions and migrates the eva extensions in. After E1, `eva/discount-engine` is a reference the later epics port *from* (E2 rewrites the discount functions in Rust; E3 splits the admin UI; E6 ports the cart transformer) — it is never deployed as its own app. The eva app's confirmed facts drive E1's config: scopes `write_discounts, write_cart_transforms, read_products`, targets `cart.lines.discounts.generate.run` + `cart.delivery-options.discounts.generate.run`, and per-DISCOUNT `$app:` JSON config metafields.

---

## Current state

The backend is the unmodified starter. Concretely:

- **Scopes** are `read_products`, `read_orders` only — `src/shopify.ts:10-13`. No discount or write scopes.
- **API version** is pinned to `ApiVersion.April26` in the library config (`src/shopify.ts:15`), and REST calls hardcode `/admin/api/2026-04/...` (`src/lifecycle/install.ts:31`, `src/lifecycle/webhooks.ts:26`). Good enough for the unified Discount API (needs 2025-04+), but there is **no GraphQL client at all** — everything is hand-rolled `fetch` against REST.
- **Webhooks**: only `app/uninstalled` is registered (`src/lifecycle/webhooks.ts:13`) and handled inline (`webhooks.ts:78-81`). HMAC verification is solid (`webhooks.ts:52-72`, timing-safe compare) but there is **no idempotency, no queue, no audit trail, no GDPR topics, no `discounts/*`**.
- **Schema**: only `shopify_shop` exists (`src/db/schema.ts`). No discount tables.
- **Auth plumbing is done and reusable**: offline token exchange + refresh in `src/middleware/shopAuth.ts:42-54` and background-safe `getShopAccessToken()` in `src/lib/getShopAccessToken.ts` — the GraphQL client will sit on top of the latter. `requireShop` (`src/middleware/requireShop.ts`) already guards `/api/*`.
- **wrangler.jsonc**: D1/KV/R2 wired; **Queues, Durable Objects, and Cron are commented out** (`wrangler.jsonc:61-75`). E1 uncomments Queues; E9 uncomments Cron. The Worker still carries the template's placeholder identity — `name: "cloudflare-shopify-starter-template"` (`wrangler.jsonc:3`), `database_id: "YOUR_DATABASE_ID"` (`wrangler.jsonc:30`), and `id: "YOUR_KV_NAMESPACE_ID"` (`wrangler.jsonc:39`). E1 provisions the real Worker name and the real D1/KV ids.
- **No `shopify.app.toml`** and no `extensions/` directory — the app is not yet declared to the Shopify CLI, so no Function or Cart Transform extension can be deployed, and there is nowhere for the migrated `eva/discount-engine` extensions to land.

**Gap:** every capability the discount engine assumes (discount write scopes, a GraphQL client for programmatic `discountAutomaticAppCreate` / metafield writes, discount-topic webhooks landing in D1, GDPR compliance for App Store review, public-app distribution, and a home for the migrated extensions) is missing. E1 closes exactly that gap and nothing more.

---

## Shopify plan gating

E1 itself is **all-plans** — nothing here is gated. Its job is to set up the distribution model that removes the gate from everything downstream.

**The public-vs-custom trap.** Shopify Functions plan gating (master doc §2, verified from official docs):

> "Stores on any plan can use public apps that are distributed through the Shopify App Store and contain functions." … "Only stores on a Shopify Plus plan can use custom apps that contain Shopify Function APIs."

So the *same Rust function code* reaches Basic/Shopify/Advanced merchants when the app is distributed as **public** (App Store or unlisted-public), but is **Plus-only** if the app is a **custom (single-store) app**. This is a distribution-channel decision, not a code decision, and it is made **here in E1** by how `shopify.app.toml` is configured and how the app is created in the Partner Dashboard. Getting this wrong at setup time silently caps the entire addressable market to Plus and contradicts the prototype's multi-tier plan page.

E1-2 therefore locks in public-app distribution as a first-class deliverable. What it does **not** do: it does not lift the Cart Transform gate. `lineExpand` / `linesMerge` / `update` operations remain **Plus-only** regardless of distribution (master doc §3), so the Bundles surface (E6/E7) stays Plus-gated. E1 only guarantees that **Discount Functions** (E2/E3) run everywhere.

---

## Architecture

### Extensions home (E1-2)

`discount-jet/extensions/` becomes the one home for every Shopify extension in the app. E1 creates the directory, wires `shopify.app.toml` at the repo root, and migrates the `eva/discount-engine` extensions in. The eva app currently ships a *monolithic* JS discount function (one `handle`/`uid`, one `$app:discount-engine.config` key, `rule_type`-dispatched across tier/bundle/special), one Preact admin UI for all three modes, and a separate `cart-transformer` JS function. E1 lands them; later epics reshape them per master doc §1a decisions (1) Rust and (2) three-way split.

Target layout after the full build (E1 seeds it; the per-type dirs are filled by E2/E3, the cart transformer ported by E6):

```
extensions/
  discount-tier/        # E2 — Rust function, target cart.lines.discounts.generate.run
  discount-bundle/      # E2 — Rust function (own handle/uid, $app:discount-bundle.config)
  discount-special/     # E2 — Rust function (own handle/uid, $app:discount-special.config)
  discount-tier-ui/     # E3 — admin UI extension, admin.discount-details.function-settings.render
  discount-bundle-ui/   # E3 — admin UI extension, linked to discount-bundle
  discount-special-ui/  # E3 — admin UI extension, linked to discount-special
  cart-transformer/     # existing eva JS function (cart.transform.run); ported/rewritten in E6
```

Each discount function extension has a **distinct `handle`, `uid`, and metafield key** — the monolith's single shared `uid`/`handle`/`$app:discount-engine.config` is **un-shared** (master doc §1a decision 2, §4). E1 does **not** perform the Rust rewrite or the three-way split itself; it establishes the directory, the app config, and migrates the eva sources so E2/E3/E6 have a working baseline to reshape. The cart-transformer JS function is migrated as-is in E1 and stays JS until E6 decides on a Rust rewrite.

The eva extension config facts E1 preserves during migration:

- `discount-function` (to become the three functions): `api_version = "2026-01"`, targets `cart.lines.discounts.generate.run` + `cart.delivery-options.discounts.generate.run`, build output `dist/function.wasm`, `[extensions.ui] handle` linking its admin UI.
- `discount-ui` (to become the three admin UIs): `type = "ui_extension"`, single target `admin.discount-details.function-settings.render`.
- `cart-transformer`: `api_version = "2026-01"`, target `cart.transform.run`, build output `dist/function.wasm`.

### GraphQL Admin API client (E1-3)

A single typed helper, `adminGraphql(shopDomain, query, variables, env)`, used by the **programmatic** background and request-context callers only. Its consumers are:

- **Templates (E5)** — create-from-template → `discountAutomaticAppCreate` / `discountCodeAppCreate` + metafield write.
- **Campaigns (E8)** — publish orchestration: create campaign-locked discounts and write their metafields.
- **Sync (E4)** — backfill/reconcile reads of existing discounts.
- **Cart transform (E6)** — `cartTransformCreate` registration.
- **Billing (E11)** — `appSubscriptionCreate` / managed pricing + the reconcile job.

**Explicitly NOT used for manual discount authoring.** Per master doc §1a decision (4), a merchant configures a discount on Shopify's **native discount page**, where the per-function **admin UI extension** (`admin.discount-details.function-settings.render`, E3) writes the config metafield via `shopify.applyMetafieldChange`. There is **no app-owned create mutation** for the manual path — the Admin client is never on it. `discountAutomaticAppCreate` appears only in the programmatic paths above, which write the **same** per-function metafield contract.

Design:

- **Token source:** `getShopAccessToken(shopDomain, env)` (`src/lib/getShopAccessToken.ts`) — offline token, auto-refreshed near expiry. Never accept a token argument; always resolve from KV at call time (honors "never pass secrets through queue messages"). If it returns `null`, throw — do **not** fall back to an empty token (fail loudly).
- **Endpoint / version:** `POST https://{shop}/admin/api/{APIVERSION}/graphql.json` with `X-Shopify-Access-Token`. `APIVERSION` is a single exported constant pinned to a **2025-04-or-later** version (see §Scopes & config) so the unified Discount Function API and `discountClasses` are available. One constant, referenced by the client and by any remaining REST call, so the version is never split-brained across files.
- **Cost-aware retry/backoff:** parse the `extensions.cost` block (`throttleStatus.currentlyAvailable`, `restoreRate`) on every response. On `THROTTLED` (HTTP 200 with a `throttled` error, or 429), sleep for `max(requestedCost − currentlyAvailable, 0) / restoreRate` seconds, then retry. Full jittered exponential backoff for `5xx` and network errors. Cap at ~5 attempts, then throw a typed `AdminGraphqlError` carrying the `userErrors`/GraphQL errors so callers can surface them.
- **userErrors are first-class:** discount mutations (`discountAutomaticAppCreate`, `metafieldsSet`) return `userErrors` on a 200. The client returns typed `{ data, userErrors }`; callers must treat a non-empty `userErrors` as a failure. A thin `assertNoUserErrors()` helper throws with the field/message.
- **Runtime:** Cloudflare Worker `fetch`; retry sleeps use `await scheduler.wait`-style delays that are safe inside a queue consumer / cron `waitUntil` context.

### Webhook processing (E1-6)

Replace the inline dispatch with a two-stage pipeline:

1. **Ingress (`POST /shopify/webhooks`, in-request):** keep the existing HMAC verification (`src/lifecycle/webhooks.ts:52-72`) — it is correct and timing-safe. Then read `X-Shopify-Topic`, `X-Shopify-Shop-Domain`, and the delivery id header (`X-Shopify-Webhook-Id`). **Idempotency check + insert** against `webhook_event` keyed on `webhookId` (see §Data model). If already present, return `200` immediately (Shopify retries on non-2xx; a duplicate must be a no-op). Otherwise insert a `received` row, **enqueue** `{ topic, shopDomain, webhookId }` (never the token, never the raw body if it can be re-fetched; for discount topics the payload is small and safe to enqueue) onto the Cloudflare Queue, and return `200` fast. GDPR topics are handled in the same ingress path (see below) because Shopify requires a timely response.
2. **Consumer (`queue` export in `src/index.ts`):** dispatch by topic to handlers. On success mark the `webhook_event` row `processed`; on throw let the message retry (Queues redelivers), and after max retries mark `failed` + dead-letter. Handlers for `discounts/create|update|delete` are **owned by E4** — E1 ships the dispatch scaffold and a no-op/stub so the wiring is testable; E4 fills the upsert.

`wrangler.jsonc`: uncomment the **Queues** block (producer binding `WEBHOOK_QUEUE` + consumer with `max_batch_size` and `max_retries`), add the binding to `Env` (`src/types/env.ts`) and export `queue` from `src/index.ts`.

### GDPR webhook handlers (E1-5)

The three mandatory topics are handled **synchronously in the ingress path** (after HMAC verify, before/alongside enqueue) so Shopify gets a prompt 200:

- **`customers/data_request`** — Discount Jet stores no personal customer data (only shop-scoped discount config). Log the request to `webhook_event` for audit; respond 200. No data export needed, but the handler must exist and verify HMAC (App Store review checks this).
- **`customers/redact`** — same: no per-customer data held; audit-log and 200.
- **`shop/redact`** — 48h after uninstall. Delete the `shopify_shop` row for the domain; the `onDelete: 'cascade'` FK on every child table (`discount`, `discount_config`, `webhook_event`, and all downstream tables) removes all shop data in one delete. This is exactly why the shared convention mandates the cascade FK. Also purge the KV offline session (`offline_{shop}`).

All three must pass HMAC verification and are registered via the standard webhook registration path (they can also be declared in `shopify.app.toml` for public apps — declare them there so they are configured at app level, and belt-and-braces register them in `registerWebhooks` too).

---

## Data model

New D1 tables owned by E1. All follow the shared conventions: `id` = `crypto.randomUUID()`, timestamps = ISO 8601 strings in `text()`, every table carries a non-null `shopId text` FK → `shopify_shop.id` with `onDelete: 'cascade'`. Drizzle definitions live in `src/db/schema.ts`; migration generated via `npm run d1:generate`.

### `webhook_event` — idempotency + audit (E1 owns, all epics use)

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `shopId` | `text` NOT NULL | FK → `shopify_shop.id`, `onDelete: 'cascade'` |
| `webhookId` | `text` NOT NULL | `X-Shopify-Webhook-Id`; **unique index** → idempotency key |
| `topic` | `text` NOT NULL | e.g. `discounts/create`, `shop/redact` |
| `status` | `text` NOT NULL | enum `received` \| `processed` \| `failed` |
| `payloadDigest` | `text` | sha-256 of raw body (audit / dedupe aid; not the body itself) |
| `error` | `text` | last failure message when `status='failed'` |
| `attempts` | `text` | retry count (stored as string per no-integer-columns convention; or `integer` if preferred — pick one and be consistent) |
| `receivedAt` | `text` NOT NULL | ISO 8601 |
| `processedAt` | `text` | ISO 8601, set on success |

Unique index on `webhookId` is the idempotency guarantee. Index on `(shopId, topic, receivedAt)` powers E12's recent-activity feed.

### `discount` — app mirror of a Shopify discount (introduced by E1, upserted by E4)

Mirrors master doc §6. Shopify is the source of truth; this is the queryable D1 copy.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `shopId` | `text` NOT NULL | FK → `shopify_shop.id`, cascade |
| `shopifyGid` | `text` NOT NULL | `gid://shopify/DiscountAutomaticNode/…` or `…/DiscountCodeNode/…`; **unique per shop** |
| `name` | `text` NOT NULL | discount title |
| `type` | `text` NOT NULL | enum `tier` \| `bundle` \| `special` (Discount Jet engine type) |
| `method` | `text` NOT NULL | enum `automatic` \| `code` |
| `status` | `text` NOT NULL | enum `active` \| `scheduled` \| `expired` \| `draft` |
| `productCount` | `text` | denormalized count for list view |
| `campaignId` | `text` | nullable FK → `campaign.id` (E8); the ownership-lock flag |
| `startsAt` | `text` | ISO 8601 |
| `endsAt` | `text` | ISO 8601, nullable |
| `createdAt` | `text` NOT NULL | ISO 8601 |
| `updatedAt` | `text` NOT NULL | ISO 8601 |

Unique index on `(shopId, shopifyGid)`. E1 defines the table; E4 owns the webhook upsert logic that populates it.

### `discount_config` — synced mirror of the function-config metafield (introduced by E1, synced by E4)

A **read-only mirror** of the per-function `$app:`-namespaced DISCOUNT metafield JSON (master doc §4), stored alongside its size for the 10 KB meter. **The app does not author this metafield.** The authoritative copy lives on the Shopify discount, written by the E3 admin UI extension (manual authoring) or by the programmatic template/campaign path (E5/E8). E1 defines the table; **E4 owns the upsert**, populating it from the `discounts/*` webhooks — this D1 row is a queryable copy, never the source of truth. The DISCOUNT function itself reads the metafield, not this table.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUID |
| `shopId` | `text` NOT NULL | FK → `shopify_shop.id`, cascade |
| `discountId` | `text` NOT NULL | FK → `discount.id`, `onDelete: 'cascade'`; **unique** (1:1) |
| `configJson` | `text` NOT NULL | the exact JSON written to the metafield |
| `sizeBytes` | `text` NOT NULL | byte length of `configJson` (UTF-8); enforced ≤ 10000 by E3 |
| `metafieldId` | `text` | `gid://shopify/Metafield/…` once written |
| `createdAt` | `text` NOT NULL | ISO 8601 |
| `updatedAt` | `text` NOT NULL | ISO 8601 |

E1 defines the table (so migrations exist from the start); **E4 owns the sync** that populates it from `discounts/*` webhooks. The E3 admin UI extension (and the E5/E8 programmatic path) write the authoritative metafield on the Shopify discount; the Rust function reads that metafield, not this table. The `sizeBytes` column mirrors the byte length the admin UI's 10 KB meter enforces at author time.

---

## Scopes & config

### OAuth scopes (E1-1)

**Match the extension app.** `eva/discount-engine`'s `shopify.app.toml` grants exactly `write_discounts,write_cart_transforms,read_products` — the single app must carry the same set so the migrated extensions run unchanged. Add `read_orders` (retained from the starter) for analytics. Replace the two-scope list in `src/shopify.ts:10-13` with these four:

| Scope | Why |
|---|---|
| `write_discounts` | programmatic create/update/delete of app discounts via `discountAutomaticAppCreate` / `discountCodeAppCreate` (templates E5, campaigns E8); **also grants read**, so sync/backfill (E4) needs no separate `read_discounts` |
| `write_cart_transforms` | register/manage the Cart Transform Function (E6, Plus-only) — matches the extension app; request now so the consent screen is stable across the build |
| `read_products` | ResourcePicker, product/variant lookup (kept from starter; required by the migrated extensions) |
| `read_orders` | kept from starter; used by analytics (E12) |

**No `read_discounts`** — `write_discounts` subsumes read; requesting it separately would be a dead scope. **No `write_products`** — the extension app does not carry it; variant-metafield handling for Cart Transform (E6) is scoped there if and when E6 proves it necessary, not requested speculatively in E1. This keeps the consent screen to the minimum the extension app actually uses.

Scopes are declared **in both** `src/shopify.ts` (library config) **and** `shopify.app.toml` `[access_scopes]` — they must match or the CLI/OAuth will disagree. Adding scopes forces existing merchants through re-consent on next load (App Bridge handles the re-auth); acceptable during pre-launch.

### `shopify.app.toml` essentials (E1-2)

New file at repo root, plus the `extensions/` directory that receives the migrated eva extensions (§Extensions home). Key blocks:

- `client_id` = the Partner Dashboard app's client id (matches `SHOPIFY_CLIENT_ID`). This is the **single** app's client id — the eva app's `b505864aecb6665908d89dfceab0ef9e` is replaced by discount-jet's, since eva is no longer deployed as its own app.
- `application_url = "https://{HOST}"`, `embedded = true`.
- `[access_scopes] scopes = "write_discounts,write_cart_transforms,read_products,read_orders"` — the four-scope set above, matching `src/shopify.ts`.
- `[auth] redirect_urls` includes `https://{HOST}/shopify/callback` (matches `src/routes/auth.ts:95`).
- `[webhooks] api_version = "2025-04"` (or the chosen 2025-04+ version) with `[[webhooks.subscriptions]]` entries for the GDPR topics and `discounts/create|update|delete`, all pointing at `https://{HOST}/shopify/webhooks`.
- **Distribution: public.** The app is created/converted to a public (App Store / unlisted-public) app in the Partner Dashboard — this is the setting that carries Function support to all plans (§Shopify plan gating). Document the exact Partner-Dashboard step in the epic README so it is not lost.

Each migrated extension keeps its own `extensions/<name>/shopify.extension.toml` (the eva `api_version`/target/build values above); the app-level `shopify.app.toml` is the single top-level config the CLI links.

### Worker provisioning (E1-2)

The `wrangler.jsonc` identity is still the template's placeholders and must be provisioned to real values as part of E1-2 (they gate every deploy):

- `name` — set from `"cloudflare-shopify-starter-template"` to the real Worker name (e.g. `discount-jet`).
- `d1_databases[0].database_id` — replace `"YOUR_DATABASE_ID"` with the id returned by `wrangler d1 create discount-jet-db` (and rename `database_name` to match).
- `kv_namespaces[0].id` — replace `"YOUR_KV_NAMESPACE_ID"` with the id returned by `wrangler kv namespace create SESSION_KV`.
- Uncomment the **Queues** block in the same pass (E1-6 depends on it).

### ApiVersion choice

Pin one constant — **`2025-04`** (Shopify `ApiVersion.April25`) — as the minimum that ships the unified Discount Function API (`cart.lines.discounts.generate.run`, `discountClasses`). The starter currently pins `April26` in `src/shopify.ts:15`, which also satisfies this; the decision is to **choose one explicit constant, export it, and use it everywhere** (GraphQL client, REST calls, webhook registration, `shopify.app.toml`) instead of the current split of `April26` in config and `2026-04` string-literals in `install.ts`/`webhooks.ts`. Whether the team lands on `2025-04` or keeps `2026-04`, the requirement is: 2025-04+ and single-sourced.

---

## Issue breakdown

### E1-1 — Set OAuth scopes to match the extension app

**What:** Set the scope list to the extension app's set (`write_discounts`, `write_cart_transforms`, `read_products`) plus `read_orders`; keep `src/shopify.ts` and `shopify.app.toml` in sync. Remove the earlier `read_discounts`/`write_products` from any draft.

**Acceptance criteria:**
- `src/shopify.ts` `scopes` array contains exactly the four scopes in §Scopes & config — `write_discounts`, `write_cart_transforms`, `read_products`, `read_orders` — and no `read_discounts` (subsumed by `write_discounts`) and no `write_products`.
- `shopify.app.toml [access_scopes] scopes` string matches the library list (same set, comma-joined) and equals the eva app's set plus `read_orders`.
- A fresh install grants all four scopes (verify via `GET /admin/oauth/access_scopes.json` or the granted-scopes claim).
- An existing install is re-prompted for consent on next load and does not break (App Bridge re-auth path).
- No scope is requested that no epic uses (no dead scopes).

**Files touched:** `src/shopify.ts`, `shopify.app.toml` (new).

### E1-2 — `shopify.app.toml` + `extensions/` migration + Worker provisioning + public-app distribution

**What:** Add the Shopify CLI app config; create `extensions/` and **migrate the `eva/discount-engine` extensions into `discount-jet/extensions/`** (the cart-transformer JS function plus the discount-function and discount-ui that E2/E3 later split into three each); provision the real Worker name and D1/KV ids; establish public-app distribution.

**Acceptance criteria:**
- `shopify.app.toml` exists at repo root with `client_id`, `application_url`, `embedded=true`, `[access_scopes]` (the four-scope set), `[auth].redirect_urls` including `/shopify/callback`, and `[webhooks]` with GDPR + `discounts/*` subscriptions.
- `shopify app config link` / `shopify app dev` recognizes the app without manual dashboard edits.
- `extensions/` exists and contains the migrated eva extensions, each with its own `shopify.extension.toml` preserved (`cart-transformer`, and the `discount-function` + `discount-ui` baseline that E2/E3 reshape into `discount-tier`/`discount-bundle`/`discount-special` + their `-ui` pairs). `shopify app deploy` (or `--dry-run`) enumerates them under the single app.
- `wrangler.jsonc` is provisioned off placeholders: real Worker `name`, real `d1_databases[0].database_id` (+ matching `database_name`), real `kv_namespaces[0].id` — none of `YOUR_DATABASE_ID` / `YOUR_KV_NAMESPACE_ID` / `cloudflare-shopify-starter-template` remain.
- Written runbook step confirms the Partner-Dashboard app is set to **public** distribution (not custom), with a one-line rationale referencing the Functions-on-all-plans gate.
- `api_version` in the toml matches the exported `APIVERSION` constant.

**Files touched:** `shopify.app.toml` (new), `extensions/**` (migrated from `eva/discount-engine`), `wrangler.jsonc`, epic runbook/README note.

### E1-3 — Typed GraphQL Admin API client (programmatic paths only)

**What:** A cost-aware, retrying GraphQL Admin client on offline tokens, for the programmatic consumers only — **not** the manual authoring path.

**Acceptance criteria:**
- `adminGraphql(shopDomain, query, variables, env)` resolves the token via `getShopAccessToken`; throws (never uses an empty-string token) when it is `null`.
- Targets `/admin/api/{APIVERSION}/graphql.json` with `APIVERSION` from a single exported constant (2025-04+).
- On `THROTTLED`/429 it waits based on `extensions.cost.throttleStatus` (`currentlyAvailable`/`restoreRate`) and retries; on 5xx/network it uses jittered exponential backoff; caps attempts and then throws `AdminGraphqlError`.
- Returns typed `{ data, userErrors }`; a helper `assertNoUserErrors()` throws on non-empty `userErrors` with field+message.
- Client is documented/scoped as the consumer surface for templates (E5), campaigns (E8), sync (E4), cart-transform registration (E6), and billing (E11) — and is **not** invoked for manual discount authoring (native page + E3 admin UI extension writes the metafield).
- Unit-tested with a mocked fetch for: success, one throttle-then-succeed, `userErrors` non-empty, and null-token throw.

**Files touched:** `src/lib/adminGraphql.ts` (new), `src/lib/adminGraphql.test.ts` (new), a shared `src/lib/apiVersion.ts` constant (new), consumed by later epics.

### E1-4 — Core discount D1 schema + migration

**What:** Add `discount`, `discount_config`, `webhook_event` tables and generate the Drizzle migration.

**Acceptance criteria:**
- Three tables added to `src/db/schema.ts` matching §Data model exactly (UUID PKs, ISO text timestamps, non-null `shopId` FK with `onDelete: 'cascade'`).
- Unique indexes: `webhook_event.webhookId`, `discount (shopId, shopifyGid)`, `discount_config.discountId`.
- `discount_config.discountId` and `discount.campaignId` FKs declared (campaign FK nullable; `campaign` table itself lands in E8 — declare the column now, add the FK constraint when E8 creates the table, to avoid a forward-reference in the migration).
- `npm run d1:generate` produces a migration; `npm run d1:migrate:local` applies cleanly on a fresh DB.
- A `shop/redact` delete of a `shopify_shop` row cascades to remove that shop's `discount`, `discount_config`, and `webhook_event` rows (verified in test).

**Files touched:** `src/db/schema.ts`, `drizzle/migrations/*` (generated).

### E1-5 — GDPR mandatory webhooks

**What:** Implement and register the three compliance webhooks.

**Acceptance criteria:**
- Handlers for `customers/data_request`, `customers/redact`, `shop/redact` exist and run **after** HMAC verification in the ingress path, each returning 200 promptly.
- `shop/redact` deletes the `shopify_shop` row (cascading all child data) and purges the `offline_{shop}` KV session.
- `customers/data_request` and `customers/redact` audit-log to `webhook_event` and 200 (app holds no per-customer PII — documented in the handler comment).
- All three are declared in `shopify.app.toml [[webhooks.subscriptions]]` and included in `registerWebhooks` `WEBHOOK_TOPICS`.
- A request with an invalid HMAC to any GDPR topic returns 401 (extends existing `webhooks.test.ts` pattern).

**Files touched:** `src/lifecycle/webhooks.ts`, `src/lifecycle/gdpr.ts` (new handlers), `src/lifecycle/webhooks.test.ts`, `shopify.app.toml`.

### E1-6 — Webhook infra: topics + queue + idempotency

**What:** Register `discounts/*`, add queue-backed processing and `webhook_event` idempotency; scaffold the dispatch that E4 fills.

**Acceptance criteria:**
- `WEBHOOK_TOPICS` includes `discounts/create`, `discounts/update`, `discounts/delete` (in addition to `app/uninstalled` and the GDPR topics).
- Ingress: after HMAC verify, dedupe on `X-Shopify-Webhook-Id` against `webhook_event.webhookId`; a duplicate returns 200 without re-processing; a new event inserts a `received` row and enqueues `{ topic, shopDomain, webhookId }` (no token, no secret).
- `wrangler.jsonc` Queues block uncommented (producer `WEBHOOK_QUEUE` + consumer with `max_retries`); `Env` has the binding; `src/index.ts` exports `queue`.
- Consumer dispatches by topic, marks `webhook_event` `processed` on success, lets the message retry on throw, and marks `failed` after max retries.
- `discounts/*` handlers are stubbed (no-op that logs + marks processed) so E4 can drop in the upsert without touching the pipeline.
- Integration test: a signed `discounts/create` delivery lands a `webhook_event` row and enqueues once; a second delivery with the same `webhookId` does not enqueue again.

**Files touched:** `src/lifecycle/webhooks.ts`, `src/lifecycle/webhookQueue.ts` (new consumer/dispatch), `src/index.ts`, `src/types/env.ts`, `wrangler.jsonc`, `src/lifecycle/webhooks.test.ts`.

---

## Testing

Follow the existing vitest integration pattern (`src/api.integration.test.ts`, `src/lifecycle/webhooks.test.ts`, `src/middleware/shopAuth.test.ts`) — mocked Hono `Context`, `computeHmac()` helper for signing, `vi.fn()` for env bindings. Run with `npm test`.

- **HMAC / GDPR (E1-5):** reuse `computeHmac` from `webhooks.test.ts`; assert 200 on valid signature and 401 on tampered body for each GDPR topic. Assert `shop/redact` triggers the shop-row delete (mock DB, assert delete called with the domain).
- **Idempotency (E1-6):** send the same signed delivery (same `X-Shopify-Webhook-Id`) twice; assert exactly one `webhook_event` insert and one enqueue. Assert distinct `webhookId`s both enqueue.
- **Queue consumer (E1-6):** unit-test the topic dispatcher directly — success marks `processed`, thrown handler leaves the message for retry, and the `discounts/*` stub is invoked.
- **GraphQL client (E1-3):** mock `fetch`; cover success, throttle-then-retry (assert the wait was computed from `throttleStatus`), non-empty `userErrors` throw via `assertNoUserErrors`, and null-token throw. Mock `getShopAccessToken`.
- **Schema/cascade (E1-4):** apply migrations to a local D1 (`npm run d1:migrate:local`), insert a shop + child rows, delete the shop, assert child rows gone (cascade).
- **Scopes (E1-1):** assert `src/shopify.ts` scope array equals the `shopify.app.toml` scope set (a small consistency test guards drift).

E2E (`npm run test:e2e`, Playwright) remains the install smoke test; verify the broader consent screen still completes an install.

---

## Risks / open questions

- **Public-app conversion timing.** Converting an existing custom/dev app to public in the Partner Dashboard can require review and a new listing; if the app was created as custom, the Function-on-all-plans benefit is not retroactive. **Mitigation:** create/verify the app as public before E2 ships any function. Open question: is an *unlisted* public app sufficient for early customers (avoids full App Store review) — believed yes, confirm with Partner terms.
- **API version single-sourcing.** Two versions currently coexist (`April26` in config, `2026-04` literals in REST calls). Consolidating to one constant is low-risk but touches install/webhook code paths; regression-test install + webhook registration after the change.
- **Queue vs. inline for GDPR.** GDPR topics are handled inline (not queued) to guarantee a fast 200 for App Store review; if `shop/redact` deletion grows slow (large cascades), it may need to move to the queue with an immediate 200 ack. Revisit if cascade delete latency becomes an issue.
- **`campaign` forward reference (E1-4).** `discount.campaignId` points at a table that does not exist until E8. Declaring the column now but deferring the FK constraint avoids a broken migration; ensure E8's migration adds the constraint rather than assuming it exists.
- **`webhook_event` growth.** High-volume shops accumulate rows; needs a retention/pruning policy (e.g. delete `processed` rows older than 30 days). Out of scope for E1 but flag for E12/ops.
- **Scope re-consent churn.** Adding scopes forces re-auth for any already-installed test shops; coordinate so QA installs are refreshed after E1-1 lands.
