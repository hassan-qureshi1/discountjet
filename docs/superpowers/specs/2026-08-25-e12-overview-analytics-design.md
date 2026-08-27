# E12 — Overview dashboard & analytics

**Date:** 2026-08-25
**Status:** Design spec — ready for `superpowers:writing-plans`
**Epic:** E12 · **Shopify plan:** All
**Depends on:** E4 (discount sync + `discount` mirror)
**Consumes:** E6 (`bundle`), E7 (`bundle_campaign`), E11 (`plan_state`), E1 (`webhook_event`)
**Issues:** E12-1 · E12-2 · E12-3 · E12-4 (master decomposition §7)

---

## Summary

E12 replaces the prototype's hardcoded Overview page with a single read-only
aggregation endpoint (`GET /api/overview`) that computes the four dashboard KPIs, the
recent-activity feed, and the bundle-schedule widget from data other epics already
persist in D1. Nothing new is written by this epic — it is a pure read/aggregate layer
over `discount` (E4), `bundle` (E6), `bundle_campaign` (E7), `plan_state` (E11), and
`webhook_event` (E1). The UI page (`Overview.tsx`) is left structurally untouched; only
its data source swaps from `overview.json` to the endpoint via the existing
`useOverview` selector, per the shared UI convention (§5 of the master doc).

The dashboard is available on **all Shopify plans**. The Bundles KPI and bundle-schedule
widget are only meaningful on **Plus** (bundles are a Plus-only surface, E6/E7); on
non-Plus stores they render `0` with an upgrade affordance rather than being hidden.

Deeper commerce analytics (revenue, orders, redemption counts) is explicitly **out of
scope** for E12 and flagged as a candidate later epic — see Risks.

---

## Current state

The Overview screen is a faithful Polaris prototype driven entirely by a hardcoded fixture:

- **Page:** `discount-engine-ui/src/pages/Overview.tsx` — renders an info `Banner`, an
  `InlineGrid` of four `StatCard`s (Active discounts, Bundles, Plan usage, Webhook sync),
  a "Recent discount activity" card, and a "Bundle schedule" card. Data comes from the
  `useOverview()` selector; the shop name comes from `useShop()`.
- **Fixture:** `discount-engine-ui/src/data/overview.json` — supplies `banner`,
  `stats[]`, `recentActivity[]`, `cartSchedule[]`. Values are static
  ("Growth plan — 6 of 50 discounts active", "6" active discounts, "Healthy" webhook sync,
  etc.).
- **Types:** `discount-engine-ui/src/types/index.ts` — `OverviewData`, `OverviewStat`,
  `StatBadge`, `ActivityItem`, `CartScheduleItem`.
- **Shared components:** `StatCard`, `SectionHeader`, `StatusBadge`, `SymbolTile` under
  `discount-engine-ui/src/components/common/`.

There is no backend for this page today: `/src` is still the unmodified starter, so no
`discount`, `bundle`, `plan_state`, or `webhook_event` tables exist until their owner
epics land. E12 assumes E4 (and, for their sections, E6/E7/E11/E1) have shipped.

---

## Shopify plan gating

Dashboard access: **all plans** (Basic / Shopify / Advanced / Plus). The endpoint and page
are never hard-gated.

Per-section behaviour:

| Section | Basic / Shopify / Advanced | Plus |
|---|---|---|
| Active discounts KPI | Real count from `discount` | Real count |
| Plan usage KPI | Real, from `plan_state` (E11) | Real |
| Webhook sync KPI | Real, from `webhook_event` (E1) | Real |
| Recent activity feed | Real, from `webhook_event` | Real |
| **Bundles KPI** | `0` + upsell (bundles are Plus-only, E6) | Real count from `bundle` |
| **Bundle schedule widget** | Upgrade prompt in place of the list | Real, from `bundle_campaign` (E7) |

- The Bundles KPI on non-Plus stores returns `value: "0"` with a `badges`/`detail`
  affordance pointing at the same Plus upgrade prompt used by E6-2, never a hard failure
  or a hidden card. This corrects the prototype fixture, which shows a populated Bundles
  KPI unconditionally.
- Plan detection reuses the E6-2 mechanism (shop Shopify plan / `BundlesFeature`), surfaced
  to the endpoint so it does not re-query Shopify per request. The **app tier** (Starter /
  Growth / Scale) shown in the Plan usage KPI is Discount Jet's own tier from `plan_state`
  (E11) and is independent of the Shopify plan — do not conflate the two (master doc §3).

---

## Architecture

E12 adds one endpoint and no new tables.

**`GET /api/overview`** — protected by `requireShop` (default-secure; no `PUBLIC_API_PATHS`
entry). Resolves `shopId` from the session and returns an `OverviewData`-shaped JSON
payload assembled from these reads, all scoped by `shopId`:

- **Active discounts KPI** — `COUNT` over `discount` where status is active, plus a
  per-type breakdown (`tier` / `bundle` / `special`) rendered as the card `detail`
  ("3 tier · 2 bundle · 1 special"). Source: E4's `discount` mirror.
- **Bundles KPI** — `COUNT` over `bundle` (E6), with active/scheduled sub-counts rendered
  as `badges`. On non-Plus stores this short-circuits to `0` + upsell (see gating).
- **Plan usage KPI** — read the single `plan_state` row (E11): `used`, `limit`, and
  `usagePercent` → `value: "12%"`, `detail: "6 / 50 discounts"`. The info banner's title
  ("Growth plan — 6 of 50 discounts active") is composed from the same row.
- **Webhook sync health KPI** — derived from `webhook_event` (E1): recency of the most
  recent successfully-processed event and whether any recent events are in an error/unprocessed
  state → `value: "Healthy" | "Delayed" | "Errors"`, `detail: "last event 2 min ago"`,
  `positive: true` when healthy. (See E12-4 for the exact health rule.)
- **Recent activity feed** — latest N (default 10) rows from `webhook_event` for
  `discounts/create|update|delete` topics, mapped to `ActivityItem` (symbol/action/meta/time).
  Title/type are resolved by joining to `discount` on `shopifyGid` where available.
- **Bundle schedule** — upcoming/active/recently-ended `bundle_campaign` rows (E7) mapped to
  `CartScheduleItem` (status, window, metafield state). Plus-only; upgrade prompt otherwise.

**Design constraints:**

- **Read-only aggregation only.** No writes, no derived analytics tables, no warehouse,
  no background rollup job in scope. Every value is computed on demand from the owning
  epics' tables. If a KPI later needs pre-aggregation for cost, that is a separate epic.
- **Fail loudly** (master doc §5): if `plan_state` is missing for a shop that should have
  one, or a required field is absent, surface the error — do not `?? ''` a zero to mask it.
  (The Bundles-on-non-Plus `0` is an intentional gated value, not a masked failure.)
- **Cost-aware:** the endpoint issues a small fixed set of indexed `COUNT`/`ORDER BY … LIMIT`
  queries against D1; it does not call the Shopify Admin API at request time (plan flag and
  all counts come from D1).
- **UI swap only:** `Overview.tsx` is not restructured. `useOverview` is repointed from the
  JSON fixture to a fetch of `/api/overview` behind the existing selector hook, matching the
  prototype's intended fixture→API swap.

---

## Data sources

Each dashboard element maps to exactly one owning table (all filtered by `shopId`):

| Dashboard element | D1 table | Owner epic | Aggregation |
|---|---|---|---|
| Active discounts KPI | `discount` | E4 | `COUNT` active + group-by `type` for the detail line |
| Bundles KPI | `bundle` | E6 | `COUNT` + active/scheduled badge sub-counts (Plus-only; else `0`+upsell) |
| Plan usage KPI + banner | `plan_state` | E11 | single-row read: `used`, `limit`, `usagePercent` |
| Webhook sync health KPI | `webhook_event` | E1 | recency of last processed event + error/backlog check |
| Recent activity feed | `webhook_event` | E1 | latest N `discounts/*` events, joined to `discount` for titles |
| Bundle schedule widget | `bundle_campaign` | E7 | active/scheduled/recently-ended windows (Plus-only) |

No table is owned by E12. The endpoint reads across epics; the response shape stays the
`OverviewData` contract already defined in `types/index.ts`.

---

## Issue breakdown

### E12-1 — Overview KPIs + aggregation endpoint

**What.** Stand up `GET /api/overview` (behind `requireShop`) and compute the four
`StatCard` KPIs plus the info banner: Active discounts (with per-type detail), Bundles
(Plus-gated), Plan usage (from `plan_state`), and a placeholder-wired Webhook sync KPI
(full health logic lands in E12-4). Repoint `useOverview` from `overview.json` to the
endpoint without changing `Overview.tsx`'s structure. Ships the shared `shopId`-scoped
query layer that E12-2..4 extend.

**Acceptance criteria.**
- `GET /api/overview` returns an `OverviewData`-shaped payload for the session's shop and
  is rejected for unauthenticated / cross-shop requests (`requireShop`), with no
  `PUBLIC_API_PATHS` entry.
- Active discounts KPI reflects real `discount` rows (active count + `"N tier · N bundle · N special"` detail).
- Plan usage KPI and the info banner are composed from the shop's `plan_state` row
  (`used` / `limit` / `usagePercent`); a missing `plan_state` fails loudly, not silently zeroed.
- Bundles KPI shows the real `bundle` count on Plus and `0` + upsell affordance on non-Plus
  stores (never hidden, never a hard failure).
- All counts are `shopId`-scoped; queries are on-demand D1 reads with no Shopify Admin API
  call at request time.
- The Overview page renders identically to the prototype layout, now driven by live data;
  no changes to `StatCard` / page JSX beyond the data source swap.

**Files touched.**
- `src/` — new route handler `GET /api/overview`; overview aggregation service/module; wiring
  into the Hono app router under the `requireShop`-protected group.
- `discount-engine-ui/src/store/useDiscountStore.ts` — `useOverview` fetches `/api/overview`.
- `discount-engine-ui/src/pages/Overview.tsx` — data-source swap only (loading/error states);
  no structural change.
- `discount-engine-ui/src/types/index.ts` — reuse `OverviewData`/`OverviewStat`; extend only
  if a loading/error discriminator is needed.

### E12-2 — Recent activity feed (from webhook events)

**What.** Populate the "Recent discount activity" card from `webhook_event` (E1): the latest
N `discounts/create|update|delete` events for the shop, mapped to `ActivityItem`
(symbol per action, `meta` = discount type, relative `time`), with titles resolved by joining
to `discount` on `shopifyGid`.

**Acceptance criteria.**
- The feed lists the most recent N (default 10) `discounts/*` webhook events for the shop,
  newest first, scoped by `shopId`.
- Each item maps to `ActivityItem`: `＋`/created, `✎`/updated, `✕`/deleted; `meta` shows the
  discount type; `time` is a relative timestamp derived from the event's ISO 8601 timestamp.
- Titles come from the joined `discount` row; a delete event whose discount row is already
  gone still renders with a sensible title from the event payload (no crash, no blank row).
- The "View all" action continues to route to `/discounts` (unchanged).

**Files touched.**
- `src/` — extend the overview aggregation module with the `webhook_event` activity query +
  `ActivityItem` mapping.
- `discount-engine-ui/src/pages/Overview.tsx` — consumes `recentActivity` from the endpoint
  (no JSX change).

### E12-3 — Bundle schedule widget

**What.** Populate the "Bundle schedule" card from `bundle_campaign` (E7): active, scheduled,
and recently-ended campaign windows mapped to `CartScheduleItem` (status, item count, window
text, metafield state). Plus-gated.

**Acceptance criteria.**
- On Plus stores the widget lists active / scheduled / recently-ended `bundle_campaign` rows
  for the shop with correct `StatusBadge` tone (Active=success, Scheduled=info, Ended=neutral)
  and a `detail` line (item count, window, metafield written/cleared state).
- On non-Plus stores the widget shows the E6-2 upgrade prompt in place of the list — not a
  hard failure and not a hidden card.
- Rows are `shopId`-scoped and ordered so active/upcoming items surface first.
- The "Manage" action continues to route to `/bundles` (unchanged).

**Files touched.**
- `src/` — extend the overview aggregation module with the `bundle_campaign` schedule query +
  `CartScheduleItem` mapping and the Plus gate.
- `discount-engine-ui/src/pages/Overview.tsx` — consumes `cartSchedule`; add the non-Plus
  upgrade-prompt branch for this card.

### E12-4 — Webhook sync-health indicator

**What.** Compute the "Webhook sync" KPI from `webhook_event` (E1): a health state derived
from the recency of the last successfully-processed event and the presence of recent
errored/unprocessed events, rendered as `value` + `detail` + `positive`.

**Acceptance criteria.**
- Health rule is explicit and documented in code:
  - **Healthy** (`positive: true`) — a recent event was processed successfully and there is
    no error/backlog; `detail` shows "last event N min ago".
  - **Delayed** — no processed events within the freshness window (staleness threshold).
  - **Errors** — one or more recent `webhook_event` rows are in an error/unprocessed state.
- The KPI value/tone/detail reflect the real `webhook_event` state, `shopId`-scoped.
- The threshold constants (freshness window, error lookback) are named constants, not magic
  numbers scattered in the query.
- Degraded states are visually distinct from Healthy (non-positive rendering) so a stalled
  sync is obvious at a glance.

**Files touched.**
- `src/` — extend the overview aggregation module with the `webhook_event` health query and
  the health-state derivation; export the threshold constants.
- `discount-engine-ui/src/pages/Overview.tsx` — consumes the sync KPI (no JSX change; already
  a `StatCard`).

---

## Testing

- **Endpoint unit tests** — seed a test shop with `discount`, `bundle`, `plan_state`,
  `bundle_campaign`, and `webhook_event` fixtures; assert `GET /api/overview` returns the
  correct KPI values, per-type breakdown, banner text, activity ordering, and schedule ordering.
- **Auth / tenancy** — assert `requireShop` rejects unauthenticated requests and that all
  aggregates are strictly `shopId`-scoped (two-shop fixture: shop A never sees shop B's rows).
- **Plan gating** — non-Plus fixture returns Bundles KPI `0` + upsell and the schedule
  upgrade-prompt branch; Plus fixture returns real bundle counts and schedule rows.
- **Fail-loud** — missing `plan_state` row surfaces an error rather than a zeroed KPI.
- **Sync health (E12-4)** — table-driven cases across the freshness/error thresholds asserting
  Healthy / Delayed / Errors and the `positive` flag; boundary tests at the thresholds.
- **Activity mapping (E12-2)** — create/update/delete events map to the right symbol/action;
  a delete whose `discount` row is gone still renders.
- **UI** — `Overview.tsx` renders the live payload with loading and error states; snapshot
  parity with the prototype layout so the data swap does not regress the design.

---

## Risks / open questions

- **No real commerce metrics in scope.** Every KPI here is a count/health signal derived from
  discount config and webhook plumbing — there is **no revenue, order, or redemption data**.
  The prototype already models `revenue`/`orders`/`discount` as nullable on `Campaign`, and
  those stay null. Real revenue/order attribution requires `orders/*` webhooks and order data;
  the current OAuth scope set (§E1-1) includes `read_orders`-class access conceptually but no
  orders ingestion, storage, or attribution pipeline exists. **Open question / recommendation:**
  treat deep commerce analytics (order-level revenue, redemption rate, per-campaign ROI,
  time-series charts) as a **later dedicated epic**, not part of E12. Flag this to product
  before any dashboard copy implies revenue reporting.
- **On-demand aggregation cost.** All KPIs are computed per request from D1. This is fine at
  starter scale but the activity feed and health scan over `webhook_event` grow with volume;
  ensure indexes on `(shopId, topic, createdAt)` / `(shopId, createdAt)` exist. If request
  cost becomes an issue, a cached/rolled-up summary is a future optimization — deliberately
  excluded now to avoid a warehouse in scope.
- **Sync-health thresholds are heuristics.** The freshness window and error-lookback constants
  (E12-4) are judgement calls; validate them against real webhook cadence and expose as
  named constants so they can be tuned without touching the query logic.
- **Cross-epic dependency ordering.** E12 reads tables owned by E4/E6/E7/E11/E1. On a store
  where a Plus-only epic (E6/E7) has not shipped or has no rows, those sections must degrade
  to the gated/empty state cleanly — the endpoint must not assume those tables are populated.
