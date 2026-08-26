# E7 — Bundle campaigns

**Date:** 2026-08-25
**Status:** Design spec — ready for `superpowers:writing-plans`
**Epic:** E7 — Bundle campaigns
**Shopify plan:** **All plans** (Cart Transform `expand`/`merge` are available on every plan; only a mode built on the `update` line-override operation would require Plus)
**App tier:** All (no additional Discount Jet tier gate; Shopify-plan gated)
**Depends on:** E6 (Cart Transform extension + Bundles CRUD), E9 (Campaign scheduling cron)
**Issues:** E7-1 · E7-2 · E7-3 (master decomposition §7)

---

## Summary

Bundle campaigns let a merchant take one or more existing **bundles** (E6 cart-transform
definitions) and run them on a **scheduled date window** with **campaign-specific pricing** — a
per-bundle `price` and `compareAtPrice` distinct from the bundle's own base price. When the window
opens, the campaign's per-bundle prices are written into the app's single `$app:cart_transform`
metafield; when it closes, they are cleared and the bundle reverts to its base pricing. All
activation and deactivation is **time-driven and delegated to the E9 cron** (≤ 5 min resolution) —
E7 owns no scheduler of its own. Shoppers see the campaign price with the compare-at struck through
and a computed saving; the editor previews exactly this.

E7 is the second and final surface of the Bundles track (`E1 → E6 → E7`), and like E6 it runs on
all Shopify plans because the campaign price rides the Cart Transform `expand`/`merge` operation
that builds the bundle line — not the Plus-gated `update` operation. It reuses E6's
bundle definitions and cart-transform registration wholesale and reuses E9's cron for execution,
adding only the campaign model, its list/editor UI, and the metafield write/clear payload contract.

---

## Current state

A faithful React + Polaris prototype exists on hardcoded JSON fixtures; it is the design source of
truth for this epic. No backend, no D1 tables, no metafield writes exist yet.

- **List** — `discount-engine-ui/src/pages/BundleCampaigns.tsx`: `Page` with a `Create campaign`
  primary action, status **tabs** (`All / Draft / Scheduled / Active / Ended`) with live per-tab
  counts, an `IndexTable` (Campaign name + bundle names, bundle count, `starts → ends` window,
  `StatusBadge`, per-row `Edit`), and an `EmptyState`. Status→tone map:
  `Draft→warning, Scheduled→info, Active→success, Ended→neutral`.
- **Editor** — `discount-engine-ui/src/pages/BundleCampaignEditor.tsx`: two-column layout.
  Left: campaign name; a repeating **per-bundle card** with `Add bundle` / `Remove`, each exposing
  `Campaign price` and `Compare-at price` number fields plus a **shopper preview**
  (`Shoppers see <price> <s>compareAt</s> [Save $X]`, where `save = max(0, compareAt − price)`).
  Right: a **Schedule** card (`Starts at` / `Ends at` free-text, "Times in store timezone (AEST) …
  next cron pass (≤ 5 min)") and a **Summary** card citing the `$app:cart_transform` metafield and
  "Cron, ≤ 5 min after start" activation.
- **Fixtures** — `discount-engine-ui/src/data/bundleCampaigns.json`: three campaigns (`bc1` Active,
  `bc2` Scheduled, `bc3` Ended), each with 1–2 `{ bundleId, price, compareAtPrice }` rows. Bundle
  IDs (`b1`…`b4`) reference E6 cart-transform fixtures via `useCartTransforms()`.
- **Types** — `discount-engine-ui/src/types/index.ts`: `BundleCampaignStatus`
  (`Draft | Scheduled | Active | Ended`), `BundleCampaignBundle` (`bundleId, price, compareAtPrice`),
  `BundleCampaign` (`id, name, status, starts, ends, bundles[]`). Store hooks already exist:
  `useBundleCampaigns`, `useBundleCampaign`, `useAddBundleCampaign`, `useUpdateBundleCampaign`,
  `useCartTransforms` (`discount-engine-ui/src/store/useDiscountStore.ts`).

Prototype gaps this epic closes: dates are free-text strings (`"2026-08-01  00:00"`), status is
never advanced by time, no plan gating, and prices live only in local component state — nothing is
persisted or written to Shopify.

---

## Shopify plan gating

Bundle campaigns run on **all Shopify plans**. Only the Cart Transform **`update`** operation
(line-override on existing, non-bundle cart lines) is Plus-gated; the **`expand`** and **`merge`**
operations are available on every plan (Shopify `cart-transform` docs). A bundle campaign's
per-bundle `price` + `compareAtPrice` are carried on the **merge/expand** operation that builds the
bundle line and sets its price — never on `update` — so no campaign in this spec requires Plus. This
matches E6: bundle definitions themselves run on all plans, and E7 only reschedules and reprices
them.

The **only** way E7 would need Plus is a future campaign mode that used the `update` operation to
override the price of existing (non-bundle) lines. This spec defines no such mode; if one is added,
gate **only** that mode, not the epic.

**Store eligibility (not plan gating).** Reuse E6-2's `BundlesFeature` store-eligibility check
(GraphQL `BundlesFeature` object) to confirm the store can register a Cart Transform / bundles at
all — this is an app-capability check, independent of the plan tier, and E7 does not re-implement
it. The check is exposed to the SPA the same way E6 exposes it (`types/index.ts`).

**Soft-gate UX (never a hard failure — master §3 product rule):**

- **Store not eligible for bundles** reaching `/bundle-campaigns`: render the same upgrade/onboarding
  surface E6-2 defines for `/bundles` (a Polaris `EmptyState`/banner explaining bundles aren't
  available for the store yet, with the appropriate outbound action). List/editor routes stay
  reachable but show the prompt in place of the table/form — no 404, no thrown error.
- **Store loses bundle eligibility while a campaign is Active:** the E9 cron's activation pass is a
  no-op for a shop that no longer passes the `BundlesFeature` check; the campaign is surfaced as
  gated. Metafield clearing on window-end still runs (deactivation must always be allowed to run so
  the storefront never gets stuck on stale campaign pricing). See Risks.
- **Server enforcement:** the `/api/bundle-campaigns/*` routes reject writes (create/activate) for
  ineligible shops with a structured, translatable error the SPA renders as the prompt — the UI gate
  is convenience, the server gate is the boundary. `requireShop` applies as normal (CLAUDE.md); the
  `BundlesFeature` eligibility check is layered on top for this router.

---

## Architecture

```
Merchant ──edits──> Bundle-campaign editor (SPA)
                          │  POST/PUT /api/bundle-campaigns
                          ▼
                 bundle_campaign  ─1:N─  bundle_campaign_bundle ──refs──> bundle (E6)
                          │ status, starts, ends            │ bundleId, price, compareAtPrice
                          │
                 (no scheduler here — status transitions are driven by time)
                          │
   E9 cron (≤5 min) ──────┴──> activation pass:  window open  → write  $app:cart_transform payload
                                deactivation pass: window closed → clear $app:cart_transform payload
                                                    │
                                                    ▼
                              Cart Transform Function (E6) reads metafield → applies
                              per-bundle campaign price + compare-at at checkout
```

**Relationship to E6.** A bundle campaign never redefines a bundle's *composition* (its
`merge`/`expand`/`update` operation, component variants, `component_reference` metafields) — that is
owned entirely by E6's `bundle` / `cart_transform` row and its variant metafields. E7 contributes
only a **time-boxed price override**: `(price, compareAtPrice)` per bundle for the campaign window.
There is **one Cart Transform per app per store** (master §4); the campaign does not create a second
one — it edits the payload of the existing `$app:cart_transform` metafield that E6 registered.

**Relationship to E9.** E7 writes no cron and starts no timers. It persists the schedule
(`starts`, `ends`) and the desired payload; the E9 cron (E9-2 activation / E9-3 deactivation, ≤ 5
min) is the sole executor. On each pass E9:

- **Activate** — for every `bundle_campaign` whose `starts ≤ now < ends` and `status ∈ {Scheduled}`:
  compose the metafield payload (below), write `$app:cart_transform`, set `status = Active`, and
  (E9-4) fire activation email notifications.
- **Deactivate** — for every `bundle_campaign` whose `now ≥ ends` and `status = Active`: remove that
  campaign's bundles from the metafield payload (clearing the whole `$app:cart_transform` value when
  no other active campaign contributes), set `status = Ended`, fire deactivation notifications.

E7's deliverable for E9 is a pure, testable **payload builder**: given the set of currently-active
`bundle_campaign_bundle` rows (across all active campaigns for the shop), produce the
`$app:cart_transform` metafield JSON that the E6 cart-transform function reads. The cron calls this
builder and does the Admin GraphQL `metafieldsSet`/delete; E7 owns the builder + its 10 KB-aware
shape (master §4 hard cap — reuse E3/E6's size accounting).

**Shopper-facing preview (parity with cart).** The editor computes and shows exactly what the Cart
Transform renders: `price` as the line price, `compareAtPrice` struck through, and
`saving = max(0, compareAtPrice − price)`. This is a pure display calc in the SPA; it mirrors the
metafield the cron will write so the merchant preview and the live cart cannot diverge.

**Status is derived, then persisted.** `Draft` (never scheduled / no valid window) and `Scheduled`
(saved with a future/open window) are set by the editor on save; `Active` and `Ended` are set only
by the E9 cron as time crosses `starts` / `ends`. The list never computes status from `now` on the
fly — it renders the persisted `status`, so the badge always matches what the cron has actually done
to the metafield.

---

## Data model

Two additive D1 tables, Drizzle-migrated, following shared conventions (master §5, CLAUDE.md): all
IDs `crypto.randomUUID()`; timestamps ISO 8601 in `text()`; every table carries a non-null
`shopId text` FK → `shopify_shop.id`, `onDelete: 'cascade'`.

### `bundle_campaign`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()`. |
| `shopId` | `text` NOT NULL | FK → `shopify_shop.id`, `onDelete: 'cascade'`. |
| `name` | `text` NOT NULL | Internal campaign name (fail loudly — no `?? ''`). |
| `status` | `text` NOT NULL | `Draft` \| `Scheduled` \| `Active` \| `Ended`. Default `Draft`. `Active`/`Ended` written only by the E9 cron. |
| `starts` | `text` NOT NULL | Window open, ISO 8601 with offset (UTC-normalized; see timezone note). |
| `ends` | `text` NOT NULL | Window close, ISO 8601 with offset. `ends > starts` enforced. |
| `activatedAt` | `text` NULL | ISO 8601; set by cron when metafield first written. Audit + idempotency. |
| `endedAt` | `text` NULL | ISO 8601; set by cron when metafield cleared. |
| `createdAt` | `text` NOT NULL | ISO 8601. |
| `updatedAt` | `text` NOT NULL | ISO 8601. |

Indexes: `(shopId, status)` for list tabs; `(shopId, starts)` / `(shopId, ends)` for the cron's
window scan.

### `bundle_campaign_bundle`

Join row: one campaign has many bundles, each with its campaign price override.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()`. |
| `shopId` | `text` NOT NULL | FK → `shopify_shop.id`, `onDelete: 'cascade'` (denormalized for tenant-scoped queries). |
| `campaignId` | `text` NOT NULL | FK → `bundle_campaign.id`, `onDelete: 'cascade'`. |
| `bundleId` | `text` NOT NULL | FK → E6 `bundle`/`cart_transform.id`, `onDelete: 'cascade'`. The referenced bundle owns the operation + components. |
| `price` | `integer`/`real` NOT NULL | Campaign price the shopper pays (store minor units or match E6's price unit — align with E6, don't diverge). |
| `compareAtPrice` | `integer`/`real` NOT NULL | Struck-through compare-at; `saving = max(0, compareAtPrice − price)`. |
| `createdAt` | `text` NOT NULL | ISO 8601. |
| `updatedAt` | `text` NOT NULL | ISO 8601. |

Constraints/indexes: unique `(campaignId, bundleId)` (a bundle appears at most once per campaign —
matches the editor's `Add bundle` dedupe); index `(shopId, bundleId)` so the cron and the overlap
check can find every active campaign touching a given bundle. `price` unit and currency follow E6's
`bundle.price` exactly — E7 introduces no new money representation.

Deleting a bundle (E6) cascades to its `bundle_campaign_bundle` rows; a campaign left with zero
bundles is invalid and cannot be `Scheduled`/`Active` (validation on save + cron skip).

---

## Issue breakdown

### E7-1 — `bundle_campaign` model + list

**What.** Create the `bundle_campaign` + `bundle_campaign_bundle` D1 tables and Drizzle migration.
Build the read API (`GET /api/bundle-campaigns`) and wire `BundleCampaigns.tsx` off it (replacing the
`bundleCampaigns.json` fixture behind `useBundleCampaigns`, no page rewrite — master §5). Preserve
the status tabs with live counts, the `IndexTable` (name + joined bundle names via
`useCartTransforms`, bundle count, `starts → ends`, `StatusBadge`), and the `EmptyState`. Apply the
E6-2 `BundlesFeature` store-eligibility gate at the route.

**Acceptance criteria.**
- Both tables migrate cleanly; every row carries `shopId`; `onDelete: 'cascade'` verified against
  `shopify_shop` deletion (GDPR `SHOP_REDACT`).
- `GET /api/bundle-campaigns` returns the shop's campaigns with nested bundle rows; protected by
  `requireShop`; a bundles-ineligible shop receives the structured gate response.
- List renders identically to the prototype (tabs, per-tab counts, badges via the existing
  `STATUS_TONE` map, empty state) with **no visual/markup change** to `BundleCampaigns.tsx` beyond
  swapping the data source.
- Bundle names resolve from live E6 bundles; a campaign referencing a deleted bundle degrades
  gracefully (falls back to id, as the prototype's `nameOf` already does).
- Status shown is the persisted value, never recomputed from `now`.

**Files touched.**
- `src/db/schema.ts` (Drizzle: `bundle_campaign`, `bundle_campaign_bundle`) + new migration under `src/db/migrations/`.
- `src/routes/` — new `bundle-campaigns` router (mounted under `/api`, `requireShop` + `BundlesFeature` eligibility gate).
- `discount-engine-ui/src/store/useDiscountStore.ts` — `useBundleCampaigns` fetches the API.
- `discount-engine-ui/src/pages/BundleCampaigns.tsx` — data-source swap only.
- `discount-engine-ui/src/data/bundleCampaigns.json` — removed once the API is live.

### E7-2 — Editor: per-bundle campaign price + compare-at, scheduled window, shopper preview

**What.** Back `BundleCampaignEditor.tsx` with create/update APIs. Persist `name`, the schedule
window, and the per-bundle `{ bundleId, price, compareAtPrice }` rows. Replace the free-text
`Starts at`/`Ends at` fields with proper date-time inputs that produce ISO 8601 with a resolved
offset (see timezone handling), keep the AEST/store-timezone helper copy, and keep the per-bundle
shopper preview (`Shoppers see … Save $X`) as a pure client calc. `Add bundle` offers only E6
bundles not already in the campaign; `Remove` is disabled at one bundle (parity with prototype).

**Acceptance criteria.**
- `POST /api/bundle-campaigns` and `PUT /api/bundle-campaigns/:id` create/update the campaign and
  its bundle rows atomically; unique `(campaignId, bundleId)` enforced.
- Save validation: non-empty `name`; `ends > starts`; ≥ 1 bundle; `price ≥ 0`, `compareAtPrice ≥ 0`.
  Failures return field-level errors the form renders — no silent `?? 0`/`?? ''` coercion of
  required fields (CLAUDE.md fail-loudly).
- On save, status is set to `Draft` (invalid/empty window) or `Scheduled` (valid future/open
  window); the editor never sets `Active`/`Ended` — those are the cron's.
- Editing an already-`Active` campaign's prices takes effect on the **next cron pass** (the payload
  is recomposed and rewritten), with a banner telling the merchant the change is not instant.
- Shopper preview matches the payload builder's output for the same inputs (shared calc; covered by a
  test so preview and live cart cannot diverge).
- Date-time inputs round-trip: value saved == value shown on reload, in store timezone.

**Files touched.**
- `discount-engine-ui/src/pages/BundleCampaignEditor.tsx` — API-backed save; date-time inputs; edit-active banner.
- `discount-engine-ui/src/store/useDiscountStore.ts` — `useAddBundleCampaign` / `useUpdateBundleCampaign` call the API; add a `useBundleCampaign(id)` fetch.
- `src/routes/` bundle-campaigns router — `POST` / `PUT` handlers + validation.
- Shared preview/saving + payload calc helper (see E7-3) consumed by the editor.

### E7-3 — Metafield write/clear on schedule (executes via E9 cron)

**What.** Define and implement the **payload builder** and the activate/deactivate contract the E9
cron invokes — E7 owns the payload shape and the state transitions; E9 owns the trigger and the
Admin GraphQL call. Given all of a shop's currently-active `bundle_campaign_bundle` rows, produce the
`$app:cart_transform` metafield JSON (the per-bundle campaign `price` + `compareAtPrice` the E6 Cart
Transform reads). On window open, merge this campaign's bundles into the metafield and flip
`status → Active` (`activatedAt` set); on window close, remove them (clearing the metafield value
entirely when no other active campaign contributes) and flip `status → Ended` (`endedAt` set).

**Acceptance criteria.**
- A pure `buildCartTransformPayload(activeRows)` function returns the metafield JSON and is unit-
  tested for: single campaign, multiple concurrent campaigns, and the empty (clear) case.
- Payload respects the **10 KB** metafield cap (master §4); the builder reports byte size and the
  editor/list surface a warning before the cron would truncate — reuse E3/E6 size accounting, do not
  reinvent it.
- Activation is **idempotent**: re-running a pass that already activated a campaign does not double-
  write or re-notify (guarded by `status`/`activatedAt`).
- Deactivation **always clears** this campaign's contribution even if the shop is now bundles-
  ineligible (storefront must never be left on stale campaign pricing).
- When two active campaigns include the same bundle, the builder applies the documented
  deterministic winner (see Risks) rather than emitting a duplicate/ambiguous entry.
- The write/clear goes through E9's token-refresh-in-background-context path (E9-1); E7 fetches no
  tokens from queue messages (CLAUDE.md).

**Files touched.**
- `src/` — `buildCartTransformPayload` + the activate/deactivate service (called by the E9 cron passes E9-2/E9-3); shares the metafield-shape module with E6.
- `src/routes/` bundle-campaigns router — expose the service to the cron; no independent scheduler.
- Tests for the payload builder + transition idempotency (see Testing).
- (E9-4 notification wiring is E9's file; E7 supplies the activate/deactivate events it consumes.)

---

## Testing

- **Payload builder (unit, pure):** single active campaign; two campaigns with disjoint bundles;
  two campaigns sharing a bundle (winner rule); empty set → clear value; a payload that exceeds
  10 KB → flagged, not silently truncated. Assert the builder's output equals the editor's shopper
  preview for identical inputs (single shared fixture).
- **State transitions (idempotency):** Scheduled→Active on first pass with `starts ≤ now < ends`;
  re-running the same pass is a no-op (no double write, no duplicate notification); Active→Ended at
  `now ≥ ends`; deactivation clears even for a now-bundles-ineligible shop.
- **API/validation:** `ends > starts`, ≥ 1 bundle, `name` non-empty, `price`/`compareAtPrice ≥ 0`;
  unique `(campaignId, bundleId)`; `requireShop` + `BundlesFeature` eligibility rejection for
  bundles-ineligible shops;
  cascade delete when the parent `shopify_shop` (and when an E6 `bundle`) is removed.
- **Timezone round-trip:** a window entered in AEST persists and reloads to the same wall-clock time;
  DST/offset boundary cases documented in the open questions produce the expected UTC instants.
- **UI (prototype parity):** list tabs + counts + badges unchanged against live data; editor
  add/remove bundle dedupe and single-bundle `Remove` disable; edit-active banner shown.
- **Cron integration (E9 seam):** with fixtures whose windows straddle `now`, one activation pass
  writes the expected `$app:cart_transform` value and one deactivation pass clears it — driven
  through the E9 cron entrypoint, asserting the Admin `metafieldsSet` payload.

---

## Risks / open questions

- **Overlap: two active campaigns touching the same bundle.** The `$app:cart_transform` metafield
  holds one price per bundle, so concurrent campaigns overriding the same `bundleId` conflict.
  *Proposed rule:* deterministic single winner — the campaign with the **later `starts`** (most
  recently activated) wins, ties broken by `createdAt`; the builder emits exactly one entry per
  bundle and the losing campaign's contribution is dropped for that bundle only. **Open:** should the
  editor **block save** when a bundle is already in another campaign whose window overlaps, warn
  non-blockingly, or allow it and rely on the winner rule? Recommendation: warn at save + enforce the
  winner rule in the builder (never emit ambiguous JSON), and surface the effective winner in the
  list/detail. Needs product sign-off.
- **Timezone: AEST vs shop timezone.** The prototype hardcodes "store timezone (AEST)" and stores
  dates as offset-less strings (`"2026-08-01  00:00"`). AEST/AEDT observes DST, so a fixed +10:00
  assumption is wrong for part of the year, and not every shop is in that zone. *Proposed:* resolve
  the merchant's actual IANA timezone from `shop.ianaTimezone` (Admin API), let the editor display
  wall-clock in that zone, and **persist `starts`/`ends` as UTC instants** so the cron's `now`
  comparison is unambiguous. **Open:** confirm we read the shop timezone rather than assuming
  Australia/Sydney, and decide behaviour when a merchant changes their shop timezone mid-campaign
  (re-interpret stored wall-clock, or keep the original instant?). Recommendation: store instants,
  keep the original instant on shop-timezone change, show a note.
- **Store loses bundle eligibility mid-campaign.** E7 is not plan-gated (all plans; the price rides
  the `expand`/`merge` op, not the Plus-only `update` op), so ordinary plan changes do not gate it.
  The residual risk is a store that stops passing the `BundlesFeature` eligibility check: activation
  must no-op under the gate, but deactivation (metafield clear) must always run so the storefront
  doesn't stick on campaign pricing. Confirm the cron treats clear-on-end as ungated.
- **Metafield 10 KB cap across many bundles.** A large campaign (or several concurrent ones) could
  push the combined `$app:cart_transform` payload past 10 KB, at which point the Cart Transform
  function receives `null` (master §4). The builder must flag this **before** the cron writes; open
  question is the exact per-bundle byte budget and whether to cap the number of bundles per campaign.
- **Base-price source of truth.** The editor seeds a new row's compare-at from the E6 bundle's
  `sumOfItems` and price. Confirm that campaign `compareAtPrice` is free-form (merchant-set) and not
  forced to equal `sumOfItems`, and that lowering base bundle price in E6 does not silently change an
  active campaign's persisted override.
