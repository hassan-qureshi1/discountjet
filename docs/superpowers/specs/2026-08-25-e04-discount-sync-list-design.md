# E4 — Discount sync + list/detail

**Date:** 2026-08-25
**Status:** Design — ready for `superpowers:writing-plans`
**Epic:** E4 (Discount sync + list/detail)
**Shopify plan:** All (Basic / Shopify / Advanced / Plus)
**Depends on:** E1 (backend foundations — OAuth scopes, GraphQL Admin client, `discount` / `webhook_event` schema, webhook infra)
**Blocks:** E12 (Overview dashboard & analytics — consumes the mirrored `discount` rows and sync-health signal)
**Issues:** E4-1 … E4-5 (master decomposition §7)

---

## Summary

Shopify is the source of truth for discounts; D1 is a queryable mirror. This epic wires the
`discounts/create | update | delete` webhooks into an upsert of the app-owned `discount` table
(keyed by the Shopify discount GID), backfills/reconciles that mirror against Shopify via GraphQL,
and exposes it through read-only list and detail APIs. It then swaps the three prototype screens
(app **Discounts** list, **Discount detail**, native **Shopify discounts** view) off their hardcoded
JSON fixtures and onto those APIs behind the existing selector hooks, without changing the page
components. E4 is read/track only — creation and editing of discounts live in E3; campaign ownership
(the `campaignId` lock) is written by E8 and only rendered here.

---

## Current state

### UI prototype (design source of truth, runs on fixtures)

- `discount-engine-ui/src/pages/Discounts.tsx` — app Discounts list. `IndexTable` with status/type
  tabs whose badges show live per-tab counts (`discounts.filter(MATCHERS[id]).length`), a
  `Badge tone="success">Synced from Shopify` title metadata, per-row campaign badge when
  `d.campaignId` is set, and a **View** action routing to `/discounts/:id`. Reads from
  `useDiscounts()`.
- `discount-engine-ui/src/pages/DiscountDetail.tsx` — read-only detail. Renders a campaign-lock
  `Banner` (tone `warning`) + "Campaign-owned" / "🔒 Locked" badges when `discount.campaignId` is
  set, otherwise the subtitle "Synced from Shopify via webhook · read-only" and a "Last synced …
  (discounts/update)" row. Reads from `useDiscount(id)` and `useCampaign(discount?.campaignId)`.
- `discount-engine-ui/src/pages/ShopifyDiscounts.tsx` — native + app discounts side by side.
  `IndexTable` over `useShopifyDiscounts()` with status tabs (All / Active / Scheduled / Expired),
  a per-row cross-reference to the app discount via `appOf(row)` (`appDiscounts.find(d => d.id ===
  row.appId)`) to attach the campaign badge and gate the Edit action, and a "managed by a campaign"
  info banner when any native row maps to a campaign-owned app discount.
- Fixtures + shapes: `discount-engine-ui/src/data/discounts.json`,
  `discount-engine-ui/src/data/shopifyDiscounts.json`; types in
  `discount-engine-ui/src/types/index.ts` (`Discount`, `ShopifyDiscount`, `DISCOUNT_TYPE_LABEL`,
  `DiscountEngineKind`).
- Store: `discount-engine-ui/src/store/useDiscountStore.ts` — Zustand store seeded from the JSON
  fixtures; pages read only through selector hooks (`useDiscounts`, `useDiscount`,
  `useShopifyDiscounts`, `useCampaign`). Its own comment says "Swap the seeds for API calls later."

### Backend (greenfield)

- `src/lifecycle/webhooks.ts` — the only webhook surface today. `WEBHOOK_TOPICS = ['app/uninstalled']`
  is the only registered topic; `handleWebhook` verifies HMAC (`timingSafeEqual`) and dispatches a
  single `app/uninstalled` branch inline. No discount topics, no idempotency, no queue routing.
- `src/db/schema.ts` — ships only `shopify_shop`. The `discount` and `webhook_event` tables are
  introduced by **E1-4**; E4 consumes them and does not define them.
- No `/api/discounts` route, no GraphQL Admin client (E1-3), no sync/backfill code exists.

Everything in this epic below the webhook signature check is new.

---

## Shopify plan gating

**All plans.** Discount → webhook → D1 sync, lists, and detail carry no Shopify Function gate
(master §3 capability matrix: "Discount → webhook → D1 sync, lists, templates … ✅ all plans").
E4 ships identically on Basic, Shopify, Advanced, and Plus. No plan detection or upgrade prompt is
part of this epic. (App-tier limits — Starter/Growth/Scale — are E11's reconcile job, unrelated to
this sync path.)

---

## Architecture

```
Shopify discount changes ──(webhook)──> POST /shopify/webhooks
        │  discounts/create | discounts/update | discounts/delete
        ▼
  HMAC verify (existing) ──> webhook_event idempotency gate (E1) ──> dispatch
        │
        ▼
  discountSync.handle(topic, payload, shopId)
        │  create/update: GraphQL hydrate node ──> classify ──> upsert `discount` (by shopifyGid)
        │  delete:        tombstone / remove row by shopifyGid
        ▼
   D1 `discount` (app-owned mirror)
        ▲
        │  backfill on install + manual reconcile  ──> discountNodes GraphQL pagination
        │
  GET /api/discounts, GET /api/discounts/:id  (D1 reads)
  GET /api/shopify-discounts                  (live GraphQL, app rows joined to D1)
```

### Webhook topics & registration

Add `discounts/create`, `discounts/update`, `discounts/delete` to the registration list in
`src/lifecycle/webhooks.ts` (registered against Admin API `2026-04`, same POST-and-ignore-422
pattern already present). `handleWebhook` gains a dispatch branch that routes all three
`discounts/*` topics into the new sync module. Registration continues to run at install (after
OAuth) alongside `app/uninstalled` and the GDPR topics (E1-5).

### Idempotency (via E1 `webhook_event`)

Shopify may deliver a webhook more than once and does not guarantee ordering. Before processing,
the handler records the delivery in `webhook_event` keyed by the `X-Shopify-Webhook-Id` header
(unique per delivery). If the id is already present, the handler returns `200` without
reprocessing. `webhook_event` also stores `topic`, `shopId`, `shopifyGid`, and received timestamp
for the sync-health surface (E4-5) and the E12 activity feed.

**Ordering guard:** because create/update can arrive out of order, the upsert is last-writer-wins by
Shopify's `updated_at` — an incoming payload whose `updatedAt` is older than the stored row's is
ignored (the row already reflects a newer state). Delete always wins (tombstone) regardless of
timestamp.

### App-owned vs native discounts

The `discounts/*` webhooks fire for **every** discount in the store, native and app-created alike.
The payload is minimal (`admin_graphql_api_id` = the discount GID, `title`, `status`, `created_at`,
`updated_at`) and does not reveal ownership or engine type. So on create/update the handler
**hydrates** the node through the E1-3 GraphQL Admin client (`discountNode(id:)`), reading
`__typename` and, for app types, `appDiscountType { app { id } functionId }`:

| Shopify node `__typename` | Method | Ownership |
|---|---|---|
| `DiscountAutomaticApp` (under `DiscountAutomaticNode`) | automatic | **app** if `appDiscountType.app.id` == our app |
| `DiscountCodeApp` (under `DiscountCodeNode`) | code | **app** if `appDiscountType.app.id` == our app |
| `DiscountAutomaticBasic` / `Bxgy` / `FreeShipping` | automatic | native |
| `DiscountCodeBasic` / `Bxgy` / `FreeShipping` | code | native |

Only **app-owned** discounts (created by this app's Function) are mirrored into the `discount`
table — it is the "app-tracked mirror" of master §6. Native discounts are **not** persisted; the
native side-by-side view (E4-4) reads them live from Shopify. A hydrated node that is not ours is a
no-op for the mirror (recorded in `webhook_event` only). See open questions for the alternative of
persisting native rows for drift accounting.

### Engine type + product count

For app-owned discounts, the engine kind (`tier` / `bundle` / `special`) and the targeted product
count are **not** available on the discount node — they live in the `$app:`-namespaced JSON
metafield on the discount owner (the config transport of master §4, written by E3 and stored in
`discount_config`). During hydration the handler reads that metafield (`config.kind`, target
selection) to populate `discount.type` and `discount.products`. If the metafield is absent (e.g. a
create webhook arriving before E3 has written config, or an app discount created outside this app),
`type` falls back to `null`/unknown and `products` to `0`, and the row is flagged for the next
reconcile pass rather than silently defaulted (master "fail loudly" rule — no `?? ''` masking of a
real value, but a nullable column with an explicit unknown state is acceptable and surfaced in
sync-health).

### GraphQL backfill + reconcile

Webhooks only cover changes *after* install and can be missed. A **backfill** runs once after OAuth
(install) and a **reconcile** runs on demand from the sync-health surface (E4-5). Both paginate the
`discountNodes` connection (cursor-based, cost-aware via the E1-3 client), classify each node as
above, and upsert app-owned rows. Reconcile additionally diffs: any `discount` row whose `shopifyGid`
is absent from the live Shopify set is tombstoned (it was deleted while a webhook was missed).
Backfill/reconcile share the same classify-and-upsert core as the webhook path.

---

## Data model

E4 consumes the `discount` and `webhook_event` tables defined by **E1-4**; it does not create them.
The columns E4 reads/writes on `discount` (per master §6, with the shared conventions of §5 — UUID
PK, ISO-8601 text timestamps, non-null `shopId` FK → `shopify_shop.id` `onDelete: 'cascade'`):

| Column | Type | Source / meaning |
|---|---|---|
| `id` | text PK | `crypto.randomUUID()` (our row id, distinct from the Shopify GID) |
| `shopId` | text FK, not null | `shopify_shop.id`; resolved from `X-Shopify-Shop-Domain` |
| `shopifyGid` | text, unique per shop | `admin_graphql_api_id` from the webhook payload — the **upsert key** |
| `name` | text | discount `title` |
| `type` | text enum `tier` \| `bundle` \| `special` \| null | from `$app:` metafield `config.kind`; null when config not yet present |
| `method` | text enum `automatic` \| `code` | from node `__typename` (see table above) |
| `status` | text enum `active` \| `inactive` | mapped from Shopify `status` (see mapping below) |
| `products` | integer | count of targeted variants parsed from the config metafield; `0` when unknown |
| `campaignId` | text FK → `campaign.id`, nullable | **ownership lock**; written by E8, read-only here |
| `deletedAt` | text ISO-8601, nullable | tombstone set by `discounts/delete` / reconcile diff |
| `createdAt` / `updatedAt` | text ISO-8601 | mirror of Shopify `created_at` / `updated_at`; `updatedAt` also drives the ordering guard |

### Status / type / method mapping from Shopify nodes

- **status:** Shopify `DiscountStatus` is `ACTIVE | SCHEDULED | EXPIRED`. The app Discounts list
  (`Discounts.tsx`) is binary (`Active` / `Inactive`), so `ACTIVE → active`, `SCHEDULED | EXPIRED →
  inactive`. The native view (E4-4) preserves the raw tri-state directly from Shopify and does not
  use this collapse.
- **method:** `DiscountAutomatic* → automatic`, `DiscountCode* → code`.
- **type (engine):** `config.kind` from the `$app:` metafield → `tier | bundle | special`. The
  internal `special` engine renders as the merchant label "Buy X, discount both"
  (`DISCOUNT_TYPE_LABEL`) and as the string **"Split"** / `DiscountEngineKind='Split'` in the native
  view.

### The `campaignId` ownership-lock flag

`campaignId` is nullable and E4 never sets it — E8's publish orchestration owns it. E4 only **reads**
it to drive the campaign badge (list), the "Campaign-owned / 🔒 Locked" banner and read-only framing
(detail), and the Edit-action gating (native view). A non-null `campaignId` means the discount is
managed by a campaign and is read-only across all three screens.

---

## API + UI

All routes sit under `/api/*` and are protected by `requireShop` (master §5); the shop is read via
`c.get('shopId')`. All are **read-only** in this epic — no create/update/delete endpoints (those are
E3). Responses are shaped to the existing prototype types so pages need no change.

### `GET /api/discounts` — app Discounts list

- Query params: `status` (tab filter: `all | tier | bundle | special | inactive`, matching the
  `MATCHERS` in `Discounts.tsx`). Filtering is applied server-side; the response also returns
  per-tab **counts** so the tab badges (`String(discounts.filter(...).length)`) render without a
  second call.
- Returns `discount` rows for the shop where `deletedAt is null`, mapped to the prototype `Discount`
  shape (`id`, `name`, `symbol`, `type`, `status`, `products`, `updated`, `campaignId?`). `type` is
  the capitalized engine (`Tier | Bundle | Special`); `updated` is the humanized `updatedAt`.
- Response shape (contract, not implementation): `{ discounts: Discount[], counts: { all, tier,
  bundle, special, inactive } }`.

### `GET /api/discounts/:id` — detail

- `:id` is the app row id. Returns the single `Discount` plus, when `campaignId` is set, the minimal
  campaign summary (`{ id, name }`) the detail banner needs (so `useCampaign` resolves). `404` when
  the row is absent or tombstoned — the page already renders a "may have been deleted in Shopify"
  empty state.

### `GET /api/shopify-discounts` — native + app side by side

- Live GraphQL `discountNodes` query (native + app), mapped to the prototype `ShopifyDiscount`
  shape (`id`, `title`, `status` tri-state, `method`, `type` label, `engine`, `appId?`, `used`).
  App-owned rows are cross-referenced to D1 by `shopifyGid` to attach `appId` (our row id) and thus
  the campaign badge / Edit gating; native rows have `engine: null` and no `appId`. `used` is the
  discount's `usageCount`/`asyncUsageCount`. Served live (not from the mirror) so `Scheduled` /
  `Expired` states and usage counts are current.

### Store rebinding (fixtures → API)

Per master §5, replace the JSON seeds in `useDiscountStore.ts` with API calls **behind the existing
selector hooks** — the three page components are untouched. Concretely: the store hydrates
`discounts` from `GET /api/discounts` and `shopifyDiscounts` from `GET /api/shopify-discounts` (on
mount / navigation), and `useDiscount(id)` is backed by `GET /api/discounts/:id`. `useDiscounts`,
`useShopifyDiscounts`, `useDiscount`, and `useCampaign` keep their signatures; loading/empty/error
states are added in the store/data layer, not in the pages. The in-memory `addDiscount` /
`updateDiscount` mutations remain the optimistic path E3 writes through.

---

## Issue breakdown

### E4-1 — `discounts/create | update | delete` webhook handlers → upsert `discount`

**What:** Register the three `discounts/*` topics; add a dispatch branch in `handleWebhook`; build
the sync module that gates on `webhook_event` idempotency (`X-Shopify-Webhook-Id`), applies the
`updated_at` ordering guard, hydrates the node via the E1-3 GraphQL client, classifies app-owned vs
native, reads engine/product-count from the `$app:` metafield, and upserts (or tombstones on delete)
the `discount` row by `shopifyGid`. Native nodes are recorded in `webhook_event` only.

**Acceptance criteria:**
- `discounts/create`, `discounts/update`, `discounts/delete` are registered at install and dispatched
  by topic; existing `app/uninstalled` behavior is unchanged.
- HMAC failure still returns `401`; a valid but duplicate `X-Shopify-Webhook-Id` returns `200`
  without a second upsert.
- An app-owned create/update upserts one `discount` row keyed by `shopifyGid` with correct
  `type` / `method` / `status` / `products` / timestamps; a second delivery with an older
  `updated_at` does not overwrite a newer row.
- `discounts/delete` sets `deletedAt` (tombstone) by `shopifyGid`; the row stops appearing in
  `GET /api/discounts`.
- A native discount webhook creates no `discount` row (only a `webhook_event`).
- Missing `$app:` config leaves `type` null / `products` 0 and flags the row for reconcile rather
  than fabricating values.

**Files touched:** `src/lifecycle/webhooks.ts` (topics + dispatch), `src/lifecycle/discountSync.ts`
(new — classify/hydrate/upsert/tombstone), `src/lib/graphqlClient.ts` (E1-3, consumed),
`src/db/schema.ts` (consumed, E1-4), `src/lifecycle/discountSync.test.ts` (new).

### E4-2 — Discounts list (IndexTable, status tabs, live counts, campaign badge)

**What:** Implement `GET /api/discounts` with server-side tab filtering + per-tab counts, and rebind
`useDiscounts` in the store to it. `Discounts.tsx` renders unchanged.

**Acceptance criteria:**
- `GET /api/discounts` returns only the caller's shop's non-tombstoned rows in the `Discount` shape,
  plus a `counts` object matching the five tabs.
- Tab badges show live counts from `counts`; switching tabs filters rows (respecting the
  `all/tier/bundle/special/inactive` matchers) without a full reload artifact.
- Rows with a non-null `campaignId` show the "Campaign" info badge.
- The route is behind `requireShop`; a request without a resolvable shop is rejected (not defaulted).
- `Discounts.tsx` is not modified.

**Files touched:** `src/routes/discounts.ts` (new), `src/index.ts` (mount),
`discount-engine-ui/src/store/useDiscountStore.ts` (fetch-backed `discounts`),
`discount-engine-ui/src/data/*` (fixtures removed/retired for this slice),
`src/routes/discounts.test.ts` (new).

### E4-3 — Discount detail (read-only, campaign-lock banner)

**What:** Implement `GET /api/discounts/:id` (single row + campaign summary when locked) and rebind
`useDiscount` / `useCampaign`. `DiscountDetail.tsx` renders unchanged.

**Acceptance criteria:**
- `GET /api/discounts/:id` returns the `Discount` and, when `campaignId` is set, `{ id, name }` for
  its campaign; `404` for missing/tombstoned ids.
- A campaign-owned discount shows the warning banner + "Campaign-owned" / "🔒 Locked" badges and the
  "Created by a campaign · read-only" subtitle; an unowned one shows "Synced from Shopify via
  webhook · read-only" with the last-synced row.
- No edit/mutation affordance is wired in this epic (detail stays read-only).
- `DiscountDetail.tsx` is not modified.

**Files touched:** `src/routes/discounts.ts` (add `:id` handler),
`discount-engine-ui/src/store/useDiscountStore.ts` (fetch-backed `useDiscount`),
`src/routes/discounts.test.ts` (extend).

### E4-4 — Native Shopify discounts view (app + native side by side)

**What:** Implement `GET /api/shopify-discounts` as a live `discountNodes` GraphQL query mapped to
`ShopifyDiscount`, joining app-owned rows to D1 for `appId` + campaign badge. Rebind
`useShopifyDiscounts`. `ShopifyDiscounts.tsx` renders unchanged.

**Acceptance criteria:**
- Response lists both native and app discounts with correct `status` (Active/Scheduled/Expired),
  `method`, `type` label, `engine` (`Tier|Bundle|Split|null`), `used`, and `appId` for app rows.
- App rows whose linked `discount` has a `campaignId` drive the "managed by a campaign" banner and
  the per-row "Campaign" badge; native rows show a disabled "View in Shopify" action.
- The Edit action is present only for app rows that are **not** campaign-owned (matches
  `!app?.campaignId`).
- `ShopifyDiscounts.tsx` is not modified.

**Files touched:** `src/routes/shopifyDiscounts.ts` (new) or an added handler in
`src/routes/discounts.ts`, `src/index.ts` (mount),
`discount-engine-ui/src/store/useDiscountStore.ts` (fetch-backed `shopifyDiscounts`),
`src/routes/shopifyDiscounts.test.ts` (new).

### E4-5 — Sync-health surface + backfill/reconcile action

**What:** Add the install-time backfill and an on-demand reconcile that paginates `discountNodes`,
upserts app-owned rows, and tombstones D1 rows missing from Shopify; expose a sync-health read
(last webhook received, last backfill/reconcile, drift/unknown-config count) and a
`POST /api/discounts/reconcile` action. This is the signal E12's sync-health indicator consumes.

**Acceptance criteria:**
- Backfill runs once after OAuth and populates the mirror from the full `discountNodes` set.
- `POST /api/discounts/reconcile` re-syncs and tombstones rows deleted-while-offline; it is
  idempotent (a second run with no Shopify changes makes no writes).
- The sync-health read returns last-webhook-received (from `webhook_event`), last reconcile time,
  and the count of rows with unknown `type`/`products`.
- Reconcile shares the classify/upsert core with E4-1 (no divergent mapping).

**Files touched:** `src/lifecycle/discountSync.ts` (backfill/reconcile export),
`src/lifecycle/install.ts` (invoke backfill post-OAuth), `src/routes/discounts.ts`
(`/reconcile` + sync-health read), `src/lifecycle/discountSync.test.ts` (extend).

---

## Testing

Follow the `src/lifecycle/webhooks.test.ts` pattern — `computeHmac(secret, body)` helper +
`createMockContext({ headers, rawBody, secret })` mocking `req.text` / `req.header` / `json`, driven
with Vitest (`npm test`).

- **Webhook handler (E4-1):** valid HMAC + `discounts/create` payload upserts one row; invalid HMAC →
  `401` (existing assertions preserved); `discounts/update` mutates the same `shopifyGid` row;
  `discounts/delete` tombstones it. Mock the GraphQL hydrate to return app-owned vs native nodes and
  assert native yields no `discount` row.
- **Idempotency:** two deliveries with the same `X-Shopify-Webhook-Id` produce one upsert; the second
  returns `200` and performs no write (assert the DB/mock write count).
- **Ordering guard:** an update carrying an older `updated_at` than the stored row is ignored.
- **Classification/mapping:** table-driven cases over `__typename` → `method`, Shopify `status` →
  `active/inactive`, and `config.kind` → `type` (incl. `special` → "Split" in the native mapping);
  missing metafield → null type / 0 products / reconcile flag.
- **List filtering (E4-2):** `GET /api/discounts?status=…` returns the right subset for each of
  `all/tier/bundle/special/inactive`; `counts` matches; tombstoned rows excluded; another shop's rows
  never leak (multi-tenancy).
- **Detail (E4-3):** `:id` returns the row + campaign summary when locked; `404` for
  missing/tombstoned.
- **Reconcile (E4-5):** a row absent from the mocked `discountNodes` set is tombstoned; a no-op
  reconcile writes nothing.

---

## Risks / open questions

- **Webhook ordering & dedup:** Shopify neither orders nor de-duplicates deliveries. Mitigated by the
  `webhook_event` id gate + `updated_at` last-writer-wins guard, but a create arriving *after* its
  delete (rare reordering) would resurrect a tombstone — the guard makes delete win only within a
  single `shopifyGid`'s timeline; confirm whether a tombstoned row must reject later creates or accept
  a genuine re-create of the same GID (GIDs are not reused, so reject is safe).
- **Backfill on install / missed webhooks:** webhooks registered at install can miss discounts created
  in the gap or while the app is unreachable. Backfill (E4-5) closes the initial gap; reconcile closes
  ongoing drift — but there is a window between a missed change and the next reconcile where the mirror
  is stale. Open question: schedule a periodic reconcile (would ride E9's cron) vs manual-only.
- **Deleted-discount tombstones vs GDPR cascade:** `deletedAt` tombstones keep history for the E12
  activity feed, but rows still cascade-delete on `shop/redact`. Open question: do tombstoned rows
  remain listable anywhere (they are excluded from `GET /api/discounts`), or is retention purely for
  analytics?
- **Native discounts not mirrored:** `discount` stores app-owned rows only; the native view is live
  GraphQL. This keeps the mirror clean but means the sync-health drift count cannot include native
  discounts, and every native-view load costs a GraphQL call. Open question: persist a lightweight
  native shadow for drift accounting / offline rendering, or accept live-only.
- **Engine type / product count depend on E3's metafield:** `type` and `products` come from the
  `$app:` config that E3 writes. Until E3 lands, or for app discounts created out-of-band, these are
  unknown and surfaced as such. Confirm the fallback presentation (badge "Unknown type") is acceptable
  in the list, or whether such rows should be hidden until reconciled.
