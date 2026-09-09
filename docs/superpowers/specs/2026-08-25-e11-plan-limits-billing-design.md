# E11 — Plan, limits & billing

**Date:** 2026-08-25
**Status:** Draft design — ready for `superpowers:writing-plans`
**Epic:** E11 — Plan, limits & billing
**Required Shopify plan (SP):** All
**Depends on:** E1 (backend foundations — OAuth, offline token, `shopify_shop`, GraphQL Admin client, webhook infra), E9 (cron host, reused by the reconcile job)
**Issues covered:** E11-1 … E11-4 (master decomposition §7)
**Master spec:** `2026-08-25-discount-jet-decomposition.md`

---

## Summary

E11 makes **Discount Jet's own commercial pricing** real. Today the plan page is a static
placeholder. This epic wires **Shopify Billing** so a merchant is on a paid **app tier**
(**Starter / Growth / Scale**), persists that tier and the shop's live usage in a new
`plan_state` table, and runs a **reconcile job** that enforces each tier's cap on the number of
**active app discounts** (Starter 10 / Growth 50 / Scale 200) by deactivating the newest
over-limit discount. It also replaces the prototype's inert Plan & limits screen with a live
usage meter and tiers table driven by `plan_state`.

The single most important thing this epic gets right — and the thing the prototype currently gets
wrong — is the **two-axis separation**: our **app tier** (a commercial count cap) is completely
independent of the merchant's **Shopify plan** (which is what actually unlocks Plus-only
cart-transform operations). See [§4](#4-shopify-plan-gating).

---

## Current state

The Plan & limits surface is a faithful but **inert M1 placeholder** — the enforcement mechanism
is described in copy but nothing is wired to Shopify Billing, and no tier is persisted or read
from a live subscription.

- **`discount-engine-ui/src/pages/PlanAndLimits.tsx`** — renders a current-plan card (usage
  meter via `ProgressBar`), a tiers `IndexTable`, and a warning banner. The page `subtitle`
  literally reads *"Placeholder tiers for M1 … limits are seeded high so it stays inert."* The
  tier rows render a hardcoded `"placeholder"` cell instead of a price or an upgrade action, and
  the current-plan card carries a `Badge tone="warning">Placeholder</Badge>`.
- **`discount-engine-ui/src/data/plan.json`** — the fixture the page reads: `current: "Growth"`,
  `used: 6`, `limit: 50`, `usagePercent: 12`, and a `tiers` array (Starter 10 / Growth 50 /
  Scale 200). Its banner says *"real Shopify Billing wiring is out of scope."*
- **`discount-engine-ui/src/types/index.ts`** — `PlanData` and `PlanTier` interfaces
  (lines 175-189). `Shop` (lines 8-15) already distinguishes `plan` (our app tier) from
  `shopifyPlan` (the merchant's Shopify plan) — the type layer already models the two axes; the
  plan page just doesn't honour it yet.
- **`discount-engine-ui/src/store/useDiscountStore.ts`** — `usePlan()` selector (line 84) hydrates
  `plan.json` into the Zustand store. E11-4 swaps the fixture behind this selector for a live API
  call, per the master-doc UI convention (§5), without changing the page.
- **`discount-engine-ui/src/components/discount/cartTransformOps.ts`** — defines the app-tier
  ordered enum `Starter < Growth < Scale` (`TIER_ORDER`, `tierAtLeast`) **and** conflates it with
  Shopify-plan gating: `OPERATIONS` assigns `minTier` (app tier) to cart-transform ops
  (`expand → Growth`, `update → Scale`) *alongside* `requiresPlus`. **This tier→operation mapping
  is incorrect** and is corrected here and in E6 — app tier must not gate which cart-transform
  operations exist. See [§4](#4-shopify-plan-gating).
- **Backend:** `src/db/schema.ts` still ships only `shopify_shop` (which has a `plan text` column,
  currently the *Shopify* plan string from install). There is no `plan_state` table, no billing
  route, and no reconcile job.

---

## 4. Shopify plan gating

There are **two independent axes**. The prototype conflates them; this section is the corrective
contract for the whole epic.

| | **App tier** (this epic) | **Shopify plan** |
|---|---|---|
| What it is | Discount Jet's own commercial pricing: **Starter / Growth / Scale** | The *merchant's* Shopify subscription: Basic / Shopify / Advanced / Plus |
| Who sets it | We do, via Shopify **Billing** | Shopify's platform |
| What it controls | The **maximum number of active app discounts** (10 / 50 / 200) | Which **platform capabilities** exist — notably Plus-only Cart Transform `expand`/`merge`/`update` |
| Enforced by | Our **reconcile job** (E11-3) | Shopify's function/API gates (surfaced by E6) |
| Source of truth | `plan_state.tier` (from the active app subscription) | `shopify_shop.plan` / `BundlesFeature` GraphQL |

**The rule, stated plainly:**

- **App tiers cap COUNT, nothing else.** Moving from Starter → Growth → Scale raises the ceiling
  on how many discounts a shop may keep active (10 → 50 → 200). It **does not** unlock any
  Shopify capability.
- **App tiers do NOT unlock Plus-only cart-transform operations.** `expand`, `merge`, and
  `update` are gated **solely** by the merchant being on **Shopify Plus** (or a dev store) — see
  master §3. A merchant on our top **Scale** tier but on a Basic Shopify plan **still cannot** use
  cart transforms. Conversely, a **Plus** merchant on our **Starter** tier can use every
  cart-transform operation — they are simply capped at 10 active discounts.
- **Correction to the prototype:** in `cartTransformOps.ts`, the `OpMeta.minTier` field
  (`expand → Growth`, `update → Scale`) implies our app tier unlocks cart-transform operations.
  That is wrong and must be removed as a *gating* input. The **only** capability gate on
  cart-transform operations is `requiresPlus` (the Shopify plan). E11 removes app-tier gating of
  operations; E6 owns the corrected Plus-only gating of the Bundles surface. `TIER_ORDER` /
  `tierAtLeast` themselves stay — they remain the correct way to compare app tiers for the **count
  cap** and for upsell copy ("Upgrade to Growth for 50 discounts").

Everything E11 enforces lives on the **left column only**. Nothing in E11 reads, gates on, or
changes the merchant's Shopify plan.

---

## 5. Architecture

### 5.1 Shopify Billing integration — chosen approach

**Choice: Shopify App Pricing (managed pricing), with `appSubscriptionCreate` (manual Billing
API) documented as the fallback.**

Shopify's **Managed Pricing** was renamed **Shopify App Pricing** and is the **default and
recommended** billing path for public App Store apps. Plans (Starter / Growth / Scale, prices,
trial days, annual/monthly) are declared in the **Partner Dashboard app submission form**, and
Shopify hosts the plan-selection page and automates **trials, proration, upgrades, and
downgrades**. Because Discount Jet is a **public app** (master §2) and our tiers are simple flat
recurring plans, managed pricing removes the need to build and maintain a purchase/confirm flow.

**Critical constraint that shapes the whole epic:** a managed-pricing app **cannot use the
Billing API to create charges** (`appSubscriptionCreate` is unavailable to it). Therefore E11
**never creates a subscription itself** under the recommended path — it only **reads** the
merchant's active subscription to learn their tier. This is fine because entitlement enforcement
only needs to *know* the current tier, not to sell it.

**How we learn and track the tier:**

1. **Redirect to buy.** The in-app "Change plan" / "Upgrade" actions redirect to the
   Shopify-hosted managed-pricing page
   (`https://admin.shopify.com/store/<shop>/charges/<app-handle>/pricing_plans`). Shopify runs
   checkout, trial, and proration.
2. **Read the active subscription** to resolve the tier: GraphQL
   `currentAppInstallation.activeSubscriptions { name status lineItems }` (offline token, via the
   E1 GraphQL client). The subscription **name** maps to our tier via the entitlement map (§5.2).
3. **Stay in sync via webhook.** Subscribe to **`app_subscriptions/update`** (registered through
   E1 webhook infra). On each event, re-read the active subscription and upsert `plan_state`
   (tier, limit, `subscriptionGid`, `subscriptionStatus`). This is the authoritative trigger for
   tier changes (approve, cancel, downgrade, frozen, expired).
4. **Default tier.** A shop with **no active paid subscription** is treated as **Starter**
   (limit 10) — the entry tier — so the app is always usable and enforcement always has a limit.

**Fallback (manual pricing), documented but not the default.** If we later need an **in-app**
plan-selection UI (rather than Shopify's hosted page) or usage-based charges, switch to the
Billing API: build the tiers table into a purchase flow, call **`appSubscriptionCreate`**
(`returnUrl` back to the app, `test: true` in dev), redirect the merchant to `confirmationUrl`,
and confirm on return. Everything downstream of "resolve tier → `plan_state`" (the entitlement
map, reconcile job, and UI) is **identical** for both paths, so this remains a drop-in swap of
E11-1 only.

### 5.2 Tier → entitlement map

A single server-side constant is the source of truth for the count cap. It maps the Shopify
subscription **name** to our tier and its active-discount limit:

| App tier | Active-discount limit | Notes |
|---|:---:|---|
| Starter | **10** | Default when no active paid subscription |
| Growth | **50** | |
| Scale | **200** | Below Shopify's platform ceiling of 25 *active discount **functions*** per store — see risk R6 |

- The **entitlement** counted is **active app discounts** (`discount.status = 'Active'` rows in the
  E4 mirror that this app owns), **not** bundles, campaigns, or native Shopify discounts.
- The limit is denormalised into `plan_state.limit` on every tier resolve so the reconcile job and
  the UI never re-derive it.
- `usagePercent` = `round(used / limit * 100)`, clamped 0-100.

### 5.3 Reconcile job

**Purpose:** keep a shop's **active app-discount count ≤ its tier limit**. The over-limit state is
reachable primarily after a **downgrade** (Scale→Growth→Starter) or a **subscription lapse**
(cancel/expire → falls back to Starter 10), and secondarily if a burst of creates races the cap.

**Algorithm (idempotent):**

1. Load `plan_state` for the shop; `limit = plan_state.limit`.
2. Count `used` = active app discounts (`discount.status='Active'`, app-owned) from the E4 mirror.
3. If `used <= limit` → set `reconcileStatus='ok'`, update `used`/`usagePercent`, **no-op**.
4. If `used > limit` → select the **newest** active discounts beyond the limit (order by
   `discount.createdAt DESC`, take `used - limit` rows). For each: deactivate in Shopify
   (`discountAutomaticAppUpdate` / `discountCodeAppUpdate` to `status: ACTIVE→disabled`, via the
   E1 GraphQL client), which flows back through the E4 `discounts/update` webhook to flip the
   mirror row to `Inactive`. Set `reconcileStatus='reconciled'` and record
   `lastReconcileAt` + a count of deactivated discounts.
5. **Never deactivate campaign-owned discounts silently as collateral of ranking** — campaign
   locks (E8 `campaignId`) are honoured: skip campaign-owned discounts in the deactivation
   selection where feasible and prefer standalone discounts first; if only campaign-owned
   discounts remain over the cap, mark `reconcileStatus='blocked'` and surface it in the UI rather
   than tearing down a published campaign. (Open question R2.)

**Deactivation policy = "newest over-limit."** Deactivating the newest preserves the merchant's
longest-standing (most-established) discounts, matches the prototype's stated behaviour
(*"deactivates the newest over-limit discount"* — `PlanAndLimits.tsx`), and is deterministic.
Deactivated discounts are **disabled, not deleted** — a subsequent upgrade lets the merchant
re-enable them manually (we do not auto-reactivate; see R3).

**How it runs:**

- **On-webhook (primary trigger for tier changes):** `app_subscriptions/update` → resolve tier →
  upsert `plan_state` → **run reconcile immediately**. This catches downgrades the moment they
  land.
- **On-create guard (fast fail):** E3's create flow checks `plan_state` before
  `discountAutomaticAppCreate`; at/over the limit it blocks with an upgrade prompt rather than
  creating a discount the reconcile job would immediately disable.
- **Cron sweep (safety net, via E9):** the E9 scheduled worker (≤5 min cron) runs reconcile for
  shops flagged dirty (recent discount create/delete webhook, or `reconcileStatus != 'ok'`). This
  catches drift from out-of-band changes (discounts toggled active directly in Shopify Admin) and
  any missed webhook. Reconcile shares E9's background token-refresh path (offline token from KV).

Reconcile is **idempotent** and safe to run repeatedly: a converged shop is always a no-op.

---

## 6. Data model

New table **`plan_state`** (Drizzle, `src/db/schema.ts`), one row per shop. Follows all shared
conventions (master §5, root `CLAUDE.md`): `shopId` non-null text FK → `shopify_shop.id`,
`onDelete: 'cascade'`; IDs `crypto.randomUUID()`; timestamps ISO 8601 strings in `text()`.

| Column | Type | Null? | Description |
|---|---|:---:|---|
| `id` | `text` PK | no | `crypto.randomUUID()`. |
| `shopId` | `text` FK → `shopify_shop.id` `onDelete:'cascade'` | no | Owning shop. **Unique** — one plan-state row per shop. |
| `tier` | `text` `{ enum: ['Starter','Growth','Scale'] }` | no | Current **app tier**. Defaults to `'Starter'`. |
| `limit` | `integer` | no | Active-discount cap for `tier` (10/50/200), denormalised from the entitlement map on every resolve. |
| `used` | `integer` | no | Count of active app-owned discounts at last reconcile. Default 0. |
| `usagePercent` | `integer` | no | `round(used/limit*100)`, clamped 0-100. Precomputed for the UI meter. Default 0. |
| `reconcileStatus` | `text` `{ enum: ['ok','reconciled','blocked'] }` | no | `ok` = at/under limit; `reconciled` = deactivated over-limit discounts on last run; `blocked` = over limit but only campaign-owned discounts remain (needs merchant action). Default `'ok'`. |
| `lastReconcileAt` | `text` (ISO 8601) | yes | When reconcile last ran. |
| `reconciledCount` | `integer` | no | How many discounts the last reconcile deactivated. Default 0. |
| `subscriptionGid` | `text` | yes | `gid://shopify/AppSubscription/…` of the active subscription; null when on default Starter with no paid subscription. |
| `subscriptionStatus` | `text` | yes | Raw Shopify subscription status (`ACTIVE`/`CANCELLED`/`FROZEN`/`EXPIRED`/…) from the last read; drives billing-state banners in the UI. |
| `createdAt` | `text` (ISO 8601) | no | Row creation. |
| `updatedAt` | `text` (ISO 8601) | no | Last mutation (tier resolve or reconcile). |

Notes:

- `tier` here (**app tier**) is deliberately distinct from `shopify_shop.plan` (**Shopify plan**).
  Do not overload one column for both.
- Migration generated via `npm run d1:generate`; applied with `d1:migrate` / `d1:migrate:local`.
- A `plan_state` row is created (defaulting to Starter/10) on first need — at install completion
  (E1) or lazily on first read — so every shop always has an authoritative limit.

---

## 7. Issue breakdown

### E11-1 — Shopify Billing integration

**What.** Wire Discount Jet's commercial billing via **Shopify App Pricing (managed pricing)**:
declare Starter/Growth/Scale plans in the Partner Dashboard submission form; add a **backend
tier-resolver** that reads `currentAppInstallation.activeSubscriptions` (E1 GraphQL client,
offline token) and maps subscription name → tier via the entitlement map; register and handle the
**`app_subscriptions/update`** webhook (E1 webhook infra + `webhook_event` idempotency) to upsert
`plan_state`; add in-app **"Change plan" / "Upgrade"** actions that redirect to the Shopify-hosted
`pricing_plans` page. Document the `appSubscriptionCreate` manual-pricing fallback (with
`test: true` for dev) as an alternative that only replaces this issue.

**Acceptance criteria.**
- Starter/Growth/Scale plans exist as managed-pricing plans; the hosted plan page is reachable
  from the app via the "Change plan" action.
- Resolver returns the correct tier for a shop with an active subscription and **defaults to
  Starter** when none exists; no code path throws on "no subscription."
- `app_subscriptions/update` webhook is registered, verified (HMAC), idempotent via
  `webhook_event`, and upserts `plan_state.{tier,limit,subscriptionGid,subscriptionStatus}`.
- Approving, downgrading, and cancelling a subscription each land the correct `plan_state` within
  one webhook cycle.
- No secrets pass through queue messages; tokens fetched from KV at processing time (master §5).

**Files touched.**
- `src/db/schema.ts` (add `plan_state`), new migration under `src/db/migrations/` (or repo
  migration dir) via `d1:generate`.
- `src/services/billing.ts` *(new)* — tier resolver + entitlement map (§5.2) + redirect-URL helper.
- `src/webhooks/appSubscriptionsUpdate.ts` *(new)* + registration in E1 webhook topic list.
- `src/routes/api/plan.ts` *(new)* — `GET /api/plan` (returns `plan_state` shaped as `PlanData`)
  and `POST /api/plan/change` (returns the managed-pricing redirect URL); guarded by `requireShop`.
- `shopify.app.toml` — webhook subscription entry for `app_subscriptions/update`.

### E11-2 — App-tier model + entitlements

**What.** Establish the tier model and the single entitlement map (Starter 10 / Growth 50 /
Scale 200) as the server-side source of truth, and expose a reusable **entitlement check** used by
the create guard and the UI. Explicitly **exclude** cart-transform operation gating from app tier
(correcting `cartTransformOps.ts`): app tier maps to a **count limit only**.

**Acceptance criteria.**
- One exported entitlement map: `tier → limit` (10/50/200); no other module hardcodes these
  numbers.
- `getEntitlement(shopId)` returns `{ tier, limit, used, usagePercent, remaining }` derived from
  `plan_state` + the live active-discount count.
- A `canCreateDiscount(shopId)` helper returns false (with an upgrade reason) when
  `used >= limit`.
- `cartTransformOps.ts` no longer uses app tier to gate cart-transform **operations**; the only
  operation gate is `requiresPlus` (Shopify plan). `TIER_ORDER`/`tierAtLeast` retained for
  count-cap comparisons and upsell copy. A code comment states the two-axis rule.
- Unit-tested: at 9/10 Starter → can create; at 10/10 → cannot, reason "Upgrade to Growth."

**Files touched.**
- `src/services/entitlements.ts` *(new)* — map + `getEntitlement` + `canCreateDiscount`.
- `src/services/billing.ts` — consume the shared map (no duplicate constants).
- `discount-engine-ui/src/components/discount/cartTransformOps.ts` — remove app-tier operation
  gating; keep tier-order helpers; add clarifying comment.
- E3 create route (`src/routes/api/discounts.ts`) — call `canCreateDiscount` before
  `discountAutomaticAppCreate` (fast-fail with upgrade prompt).

### E11-3 — Reconcile job

**What.** Implement the idempotent reconcile algorithm (§5.3): compare active app-discount count
vs `plan_state.limit`, deactivate the **newest** over-limit discounts in Shopify (disable, not
delete), honour campaign locks, and persist `reconcileStatus` / `lastReconcileAt` /
`reconciledCount`. Wire its three triggers: **on-webhook** (`app_subscriptions/update`),
**on-create guard** (E3), and **cron sweep** (E9) for dirty/non-`ok` shops.

**Acceptance criteria.**
- Under-limit shop → reconcile is a **no-op**, `reconcileStatus='ok'`, `used`/`usagePercent`
  refreshed.
- Over-limit shop → exactly `used - limit` discounts deactivated, chosen **newest-first** by
  `discount.createdAt`; each deactivated via the correct GraphQL update mutation; mirror rows flip
  to `Inactive` via the E4 webhook.
- Reconcile is **idempotent** — a second immediate run is a no-op.
- Downgrade Scale→Starter with 30 active standalone discounts leaves exactly 10 active.
- Campaign-owned discounts are not torn down as ranking collateral; if only campaign-owned
  discounts exceed the cap, `reconcileStatus='blocked'` and no campaign discount is disabled.
- Deactivations are disables (re-enable-able), never deletes.

**Files touched.**
- `src/services/reconcile.ts` *(new)* — the algorithm; consumes entitlements + E4 mirror + E1
  GraphQL client.
- `src/webhooks/appSubscriptionsUpdate.ts` — call reconcile after `plan_state` upsert.
- `src/scheduled.ts` (E9 cron entry) — enqueue/run reconcile for dirty/non-`ok` shops; reuse E9
  background token refresh.
- `src/routes/api/discounts.ts` — post-create guard already added in E11-2.

### E11-4 — Plan & limits UI

**What.** Replace the inert placeholder page with a live view driven by `plan_state`: current-tier
card, usage meter (`used / limit`, `usagePercent`), a tiers table with prices and an
**Upgrade/Change plan** action (redirect from E11-1), a **reconcile-status** surface (ok /
reconciled-N / blocked), and a billing-state banner from `subscriptionStatus`. Swap `plan.json`
behind the existing `usePlan()` selector for `GET /api/plan` without changing the page's shape
(master §5 UI convention). Remove the "Placeholder"/"M1" copy.

**Acceptance criteria.**
- Page renders live `plan_state`: correct tier, `used/limit`, meter, and `Current` badge on the
  active tier row.
- Tiers table shows Starter 10 / Growth 50 / Scale 200 with real prices and a working
  **Change plan** action that redirects to the Shopify-hosted pricing page.
- When `reconcileStatus='reconciled'`, an informational banner states N discounts were deactivated
  because the shop is over its limit; `blocked` shows an actionable warning.
- No "placeholder"/"M1"/"out of scope" copy remains; the warning `Badge`/banner reflect real
  billing state, not a placeholder.
- The page keeps clear the two-axis distinction in copy (tier caps discount **count**; it does not
  unlock Plus features).
- `PlanData`/`PlanTier` types extended (e.g. `price`, `reconcileStatus`, `subscriptionStatus`) and
  the API response conforms.

**Files touched.**
- `discount-engine-ui/src/pages/PlanAndLimits.tsx` — live data, upgrade action, reconcile banner,
  remove placeholder copy.
- `discount-engine-ui/src/types/index.ts` — extend `PlanData` / `PlanTier`.
- `discount-engine-ui/src/store/useDiscountStore.ts` — `usePlan()` hydrates from `GET /api/plan`.
- `discount-engine-ui/src/data/plan.json` — removed or demoted to a dev/test fixture only.

---

## 8. Testing

**Entitlement checks (E11-2).**
- Map returns 10/50/200 for Starter/Growth/Scale; unknown subscription name → treated as Starter.
- `canCreateDiscount`: boundary at `used == limit` (block) vs `used == limit-1` (allow); reason
  string names the next tier.
- `usagePercent` clamps: `used=0 → 0`, `used=limit → 100`, `used>limit → 100`.
- Regression: `cartTransformOps` operation gating no longer depends on app tier — a Starter +
  Plus shop can select `expand`/`update`; a Scale + Basic shop cannot.

**Reconcile logic (E11-3).**
- No-op when under/at limit; idempotent on repeat runs.
- Over-limit selects newest-first by `createdAt`, count = `used - limit`.
- Downgrade path: seed 30 active → set limit 10 → exactly 20 deactivated, 10 active remain.
- Campaign-lock path: over-limit set that is entirely campaign-owned → `blocked`, zero deactivated.
- Mixed set prefers standalone discounts for deactivation before campaign-owned.
- Deactivations call the correct GraphQL mutation and set status to disabled (not delete);
  mock the E1 client and assert calls.

**Billing callback / webhook handling (E11-1).**
- `app_subscriptions/update` with valid HMAC → `plan_state` upsert; invalid HMAC → 401, no write.
- Idempotency: same webhook delivered twice → single state change (`webhook_event` dedup).
- Status transitions ACTIVE→CANCELLED and ACTIVE(Scale)→ACTIVE(Growth) each land correct
  `tier`/`limit`/`subscriptionStatus` and trigger a reconcile.
- No active subscription → resolver yields Starter/10 without error.
- Manual-pricing fallback (if used): `appSubscriptionCreate` uses `test: true` in dev and returns
  a `confirmationUrl`; return handler resolves tier and upserts `plan_state`.

**UI (E11-4).**
- `GET /api/plan` shape matches `PlanData`; page renders meter and current-tier badge.
- Reconcile banners render for `reconciled`/`blocked`; hidden for `ok`.
- Change-plan action navigates to the managed-pricing URL.

---

## 9. Risks / open questions

- **R1 — Billing test mode.** Managed pricing has no `test` flag equivalent to the Billing API's
  `test: true`; testing charge flows needs a **development store** (dev/partner stores are not
  charged). The manual-pricing fallback path *does* support `test: true`. Decide whether pre-launch
  billing verification uses a dev store on managed pricing or a temporary manual-pricing build.
- **R2 — Downgrade reconcile vs campaign locks.** When a downgrade pushes a shop over the cap and
  the over-limit discounts are **campaign-owned** (E8 lock), tearing them down would silently
  break a published campaign. Current design marks `reconcileStatus='blocked'` and defers to the
  merchant. Open: exact UX — force-block new-tier until they resolve, grace period, or allow a
  temporary over-limit for campaign-owned discounts only?
- **R3 — Re-activation after upgrade.** We **disable** (not delete) over-limit discounts. On
  upgrade we do **not** auto-reactivate (which of the previously-disabled to restore is ambiguous,
  and auto-enabling could resurrect stale offers). Confirm merchants are OK re-enabling manually;
  consider surfacing a "recently auto-disabled" list to make this one-click.
- **R4 — Proration & mid-cycle changes.** Managed pricing handles proration for us; the manual
  fallback does not (we'd compute it). This is another reason to prefer managed pricing. Confirm
  the plan prices/trial-days declared in the submission form match commercial intent before
  submission (they're not trivially changeable post-approval).
- **R5 — Plan-string source of truth.** `shopify_shop.plan` currently holds the *Shopify* plan
  from install. Do **not** repurpose it for the app tier — app tier lives only in
  `plan_state.tier`. Audit any existing reads of `shopify_shop.plan` to ensure none assume it means
  our tier.
- **R6 — Scale (200) vs Shopify's function ceiling.** Shopify caps a store at **25 active discount
  *functions*** per store (master §4). Our Scale limit of **200 active app discounts** counts
  *discounts*, not *functions* — many discounts share our single discount function — so 200
  discounts is compatible with the 25-function ceiling. Verify this holds for the code-discount
  path and document the distinction so the cap isn't mistaken for a function-count limit.
- **R7 — Race between create bursts and the cap.** The on-create guard (E11-2) plus the cron sweep
  (E9) should prevent sustained over-limit, but concurrent creates could momentarily exceed the
  cap before the guard reads `used`. Reconcile converges it; confirm the transient window is
  acceptable or add a short-lived per-shop create lock.

**Sources (Shopify Billing grounding):**
[Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing) ·
[appSubscriptionCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate) ·
[About billing for your app](https://shopify.dev/docs/apps/launch/billing) ·
[Managed Pricing apps cannot use the Billing API](https://community.shopify.com/t/managed-pricing-apps-cannot-use-the-billing-api-to-create-charges/382390)
