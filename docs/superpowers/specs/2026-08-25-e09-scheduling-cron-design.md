# E9 — Campaign scheduling cron

**Date:** 2026-08-25
**Epic:** E9 — Campaign scheduling cron
**Shopify plan:** All (the cron itself); bundle-campaign activation is Plus-only (see §4)
**Depends on:** E1 (backend foundations — GraphQL Admin client, offline-token refresh, D1 schema, webhook infra)
**Blocks / serves:** E7 (bundle-campaign scheduling executes here), E8 (campaign activation/deactivation and the publish→schedule handoff execute here)
**Issues:** E9-1 … E9-4 (master decomposition §7)
**Master spec:** `2026-08-25-discount-jet-decomposition.md`

---

## 2. Summary

E9 is the time engine behind campaigns. A single Cloudflare Cron Trigger fires the Worker's
`scheduled()` export at a fixed interval of **≤ 5 minutes**. Each pass runs two idempotent
sweeps across every installed shop:

- **Activation pass** — find campaigns and bundle campaigns whose scheduled window has *opened*
  and are not yet live, then bring them live: publish their discounts via the Admin GraphQL API
  (`discountAutomatic*/Code*` state), write the `$app:` config/`cart_transform` metafields, mark
  status `Active`, and fire "activated" email notifications.
- **Deactivation pass** — find campaigns/bundle campaigns whose window has *closed*, then tear
  them down: clear the `cart_transform` metafield, deactivate the owned discounts, mark status
  `Ended`, and fire "deactivated" email notifications.

The cron is the only place status transitions `Scheduled → Active → Ended` happen automatically.
It is the mechanism the prototype's copy already promises across two surfaces:

- `CampaignBuilder.tsx` Schedule step — *"Discounts created and metafield written on the next
  cron pass (≤ 5 min)"* and *"The app activates and deactivates the whole campaign
  automatically"* — with a marketing-notify email field defaulting to `marketing@evahome.com`.
- `BundleCampaignEditor.tsx` Summary — *"Activation: Cron, ≤ 5 min after start"*, writing/clearing
  `$app:cart_transform` on the schedule boundary.

This epic honors the master-doc conventions verbatim: **no secrets in queue/cron messages**
(offline tokens are fetched from KV at processing time via `getShopAccessToken`), and **fail
loudly** (a missing token, domain, or GID aborts that shop's work with a logged error rather than
masking it with a fallback).

---

## 3. Current state

- **Prototype already contracts the cron.** Both scheduling surfaces reference cron activation in
  their copy:
  - `discount-engine-ui/src/pages/CampaignBuilder.tsx:338` — Schedule step ChoiceCard: *"Discounts
    created and metafield written on the next cron pass (≤ 5 min)."*
  - `CampaignBuilder.tsx:339` — *"The app activates and deactivates the whole campaign
    automatically."*
  - `CampaignBuilder.tsx:347-352` — `EmailTagField` ("Notify marketing when the schedule
    triggers"), `helpText="We email these people when the campaign activates and when it
    deactivates."`, default `notifyEmails = ['marketing@evahome.com']` (`CampaignBuilder.tsx:74`).
  - `CampaignBuilder.tsx:406` — Review shows the window annotated **"(AEST)"**; `:408` shows the
    `$app:cart_transform` metafield term.
  - `BundleCampaignEditor.tsx:182-185` — *"Times in store timezone (AEST). The app activates and
    deactivates the campaign automatically on the next cron pass (≤ 5 min)."*
  - `BundleCampaignEditor.tsx:199-206` — Summary: *"Activation: Cron, ≤ 5 min after start"* and
    *"When the window opens, each bundle's price and compare-at price are written into the
    cart-transform metafield, and cleared when it closes."*
- **Backend cron is not wired.** `wrangler.jsonc:74-75` carries the Cron trigger as a commented-out
  opt-in example: `// "triggers": { "crons": ["0 * * * *"] }`. No `scheduled` export exists in
  `src/index.ts` (only `fetch`, `src/index.ts:39-41`). `src/CLAUDE.md` explicitly documents the
  wiring path: *"To add Queues, Durable Objects, or cron triggers, uncomment the matching block in
  `wrangler.jsonc` and add the corresponding export to `src/index.ts` (`queue`, `scheduled`)."*
- **Background token refresh is ready.** `src/lib/getShopAccessToken.ts` was built for exactly this
  use — its docstring reads *"Use this in background contexts (cron, queues, webhooks) where no App
  Bridge JWT is available."* It loads `offline_<shop>` via `KVSessionStorage`, refreshes near
  expiry (5-min buffer), and returns `null` on absence/failure (caller must fail loudly).
- **Shop timezone is captured.** `shopify_shop.ianaTimezone` (`src/db/schema.ts`) already stores the
  IANA zone, so the cron can resolve AEST-authored windows to UTC per shop rather than assuming one.
- **Dependencies from E1 assumed present:** typed cost-aware GraphQL Admin client (E1-3), the
  `discount` / `discount_config` / `webhook_event` tables (E1-4), and webhook-driven `discount` sync
  (E4). The `campaign` (E8) and `bundle_campaign` (E7) tables are owned by their epics; E9 only reads
  their schedule columns and drives their `status`.

---

## 4. Shopify plan gating

Two independent axes (master §3): the merchant's **Shopify plan** vs Discount Jet's **app tier**
(E11). E9's gating is on the Shopify plan.

- **The cron itself is All-plan.** Activating/deactivating code + automatic **discounts** and writing
  `$app:` DISCOUNT metafields uses Admin GraphQL that works on Basic / Shopify / Advanced / Plus.
  Campaigns (E8) that contain only discounts schedule and unschedule on every plan.
- **Bundle-campaign activation is Plus-only.** The `$app:cart_transform` write/clear path
  (`BundleCampaignEditor`, E7) drives a Cart Transform Function, and `lineExpand`/`linesMerge`/
  `update` operations run only on **Plus** (or dev stores) — master §3 capability matrix,
  E6/E7. The cron must therefore **skip the bundle-campaign branch for non-Plus shops** and log a
  clear reason, never attempt the metafield write and fail at checkout.
- **Plan is read, not assumed.** The pass resolves the shop's plan from `shopify_shop.plan` (kept
  fresh by E11 reconcile / install). If a bundle campaign is somehow scheduled on a shop that has
  since dropped off Plus, the activation branch is a **no-op with a loud log**, and the bundle
  campaign is left `Scheduled` (not silently `Active`) so the E7 UI can surface the gate.
- Discount-only campaign scheduling is unaffected by the Plus gate.

---

## 5. Architecture

### 5.1 Trigger + entry point

- **Cloudflare Cron Trigger** configured in `wrangler.jsonc` at `*/5 * * * *` (every 5 minutes —
  the tightest cadence that satisfies the prototype's "≤ 5 min" promise without over-invoking).
  This replaces the commented-out `"triggers": { "crons": ["0 * * * *"] }` example.
- A new **`scheduled(event, env, ctx)`** export is added alongside the existing `fetch` export in
  `src/index.ts`. It is a thin adapter: it sets up the per-invocation Drizzle client (`setDb(env.DB)`,
  mirroring the request middleware at `src/index.ts:13-16`) and delegates to `runSchedulingPass()`
  in `src/cron/`. Long-running work is handed to `ctx.waitUntil()` so the pass can finish after the
  handler returns.
- The scheduling pass has **no HTTP context** — no `requireShop`, no `c.get('shopId')`. It iterates
  shops itself (see 5.3). It never becomes a public route; it is invoked only by the platform's cron.

### 5.2 Module layout (`src/cron/`)

- `src/cron/runSchedulingPass.ts` — orchestrator: enumerate installed shops → for each, run
  activation then deactivation → aggregate a per-pass summary log.
- `src/cron/activate.ts` — activation pass for one shop (campaigns + bundle campaigns).
- `src/cron/deactivate.ts` — deactivation pass for one shop.
- `src/cron/publishDiscounts.ts` — GraphQL helpers to flip discount state / write DISCOUNT
  metafields (shared with E8-5 publish orchestration; E8 does the create, E9 does the
  activate/deactivate state flips).
- `src/cron/cartTransformMetafield.ts` — write/clear `$app:cart_transform` for bundle campaigns
  (shared with E7-3).
- `src/cron/notify.ts` — email dispatch (see §7).
- `src/cron/clock.ts` — injectable "now" (see §9).

### 5.3 Per-shop loop and token handling

1. Select installed shops from `shopify_shop` (`status = 'installed'`). For each shop, do work in
   its own try/catch so one shop's failure never aborts the pass.
2. **Only fetch the offline token when there is due work** for that shop (avoid refreshing tokens
   for idle shops). Fetch via `getShopAccessToken(shopDomain, env)` at processing time —
   **the token is never passed into the cron event, a queue message, or any persisted row.** This
   is the master rule *"never pass secrets through queue messages; fetch tokens from KV at
   processing time"* applied to the cron context, and is precisely what `getShopAccessToken`'s
   docstring anticipates.
3. If `getShopAccessToken` returns `null`, **fail loudly for that shop**: log
   `[cron] no offline token for <shop>, skipping` and skip — do not fall back to an empty token or
   swallow the due campaigns silently. The campaigns stay in their current status and are retried
   on the next pass.

### 5.4 Activation pass

For a shop with a valid token, at wall-clock `now` (UTC):

**Campaigns (E8), all plans:**
1. `SELECT` campaigns where `status = 'Scheduled'` AND `startsAt <= now` AND (`endsAt IS NULL` OR
   `endsAt > now`). ("Immediate on publish" campaigns are stored with `startsAt = publish time`, so
   they fall out of the same query on the next pass.)
2. For each, load its owned `campaign_discount` rows → the mirrored `discount` GIDs. Ensure each
   discount is **active** in Shopify: the discount node was created at publish time (E8-5); the cron
   flips/asserts its `status` to `ACTIVE` and (re)writes the `$app:` DISCOUNT config metafield if the
   campaign carries schedule-dependent config. Uses `discountAutomaticAppUpdate` /
   `discountCodeAppUpdate` (or the activate mutation) via the E1-3 client.
3. Transition `campaign.status = 'Active'`, stamp `activatedAt`.
4. Enqueue an "activated" notification (§7).

**Bundle campaigns (E7), Plus only:**
5. Gate on `shopify_shop.plan` (see §4). If not Plus → skip + log, leave `Scheduled`.
6. `SELECT` bundle campaigns where `status = 'Scheduled'` AND `startsAt <= now` AND `endsAt > now`.
7. For each, serialize the campaign's per-bundle price + compare-at into the `$app:cart_transform`
   metafield JSON and **write** it (respecting the 10 KB cap; fail loudly if exceeded — do not
   truncate). This is the `BundleCampaignEditor` contract "price and compare-at price are written
   into the cart-transform metafield".
8. Transition `bundle_campaign.status = 'Active'`, stamp `activatedAt`.
9. Enqueue an "activated" notification.

### 5.5 Deactivation pass

10. `SELECT` campaigns/bundle campaigns where `status = 'Active'` AND `endsAt <= now`.
11. Campaigns: deactivate each owned discount (`discount...Update` → `ACTIVE`→`DISABLED`, or the
    deactivate mutation). Bundle campaigns: **clear** the `$app:cart_transform` metafield
    (delete the metafield / write empty per E7-3 contract) so the Cart Transform Function stops
    firing.
12. Transition `status = 'Ended'`, stamp `endedAt`.
13. Enqueue a "deactivated" notification.

### 5.6 Idempotency

Every pass must be safe to run twice (cron fires roughly-on-time, at-least-once semantics — see
§10). Idempotency rules:

- **Status-guarded queries.** Activation only ever selects `Scheduled` rows and moves them to
  `Active`; deactivation only selects `Active` rows past `endsAt`. A campaign already `Active` is not
  re-activated; already `Ended` is not re-ended. The status column is the transition guard.
- **GraphQL flips are convergent.** Setting a discount to `ACTIVE` that is already active, or writing
  a metafield to the value it already holds, is a no-op at Shopify — safe to repeat.
- **Notification de-dup.** Each notification is keyed by `(campaignId, event)` in the `notification`
  send log (§6); a send is attempted only if no successful row exists for that key. This prevents a
  retried pass, or an overlapping pass, from emailing marketing twice for the same activation.
- **Reuse `webhook_event`-style idempotency mindset** (E1-6): the `notification` sent-log row is the
  E9 analogue of the inbound-webhook idempotency record.

---

## 6. Data model

### 6.1 `notification` table (owned by E9, master §6)

Additive D1 table, following shared conventions (UUID PK, ISO-8601 text timestamps, non-null
`shopId` FK → `shopify_shop.id` `onDelete: 'cascade'`).

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `crypto.randomUUID()` |
| `shopId` | text NOT NULL | FK → `shopify_shop.id`, `onDelete: 'cascade'` |
| `campaignId` | text | The campaign or bundle-campaign this notification is for |
| `campaignKind` | text `{ 'campaign', 'bundle_campaign' }` | Which surface (E8 vs E7) |
| `event` | text `{ 'activated', 'deactivated' }` | Trigger point |
| `recipients` | text (JSON array) | Serialized from the `EmailTagField` value (e.g. `["marketing@evahome.com"]`) |
| `status` | text `{ 'pending', 'sent', 'failed' }` | Send-log state |
| `error` | text | Provider error message when `failed` (fail loudly — recorded, not swallowed) |
| `attempts` | text/int | Retry counter |
| `scheduledFor` | text (ISO 8601) | The window boundary that triggered it |
| `sentAt` | text (ISO 8601) | Stamp on success |
| `createdAt` / `updatedAt` | text (ISO 8601) | |

- **Unique idempotency key:** `(shopId, campaignId, event)` — the send-log de-dup from §5.6.
- `recipients` are captured at **campaign publish time** from the Schedule step's `EmailTagField`
  (the campaign/bundle-campaign row stores the notify list); the cron copies them into the
  `notification` row so an edit after publish doesn't retroactively change who was notified.

### 6.2 Status transitions driven by the cron

The cron is the authority for the automatic portion of a campaign's lifecycle. Status columns live
on the E7/E8 tables; E9 only *drives* these transitions:

```
Draft ──(publish, E8-5/E7)──▶ Scheduled ──(cron activation, E9-2)──▶ Active ──(cron deactivation, E9-3)──▶ Ended
                                  │
                                  └─(immediate-on-publish: startsAt = now, picked up next pass)─▶ Active
```

- `Draft → Scheduled`: owned by the builder/publish (E8-5, E7-3), **not** the cron.
- `Scheduled → Active`: **E9-2** activation pass, when `startsAt <= now`.
- `Active → Ended`: **E9-3** deactivation pass, when `endsAt <= now`.
- Campaigns without an `endsAt` stay `Active` indefinitely (no deactivation).
- The prototype's title Badge "Draft" (`CampaignBuilder.tsx:154`) and the list status values
  (`Scheduled`/`Published`, `CampaignBuilder.tsx:131`) map onto this: publish → `Scheduled` (windowed)
  or immediate → picked up as `Active` next pass.

---

## 7. Email notifications

### 7.1 Trigger points

- **On activation** (E9-2 / §5.4 step 4, step 9): one email per campaign that goes live in this pass.
- **On deactivation** (E9-3 / §5.5 step 13): one email per campaign that ends in this pass.

These are exactly the two moments the prototype promises: *"We email these people when the campaign
activates and when it deactivates."* (`CampaignBuilder.tsx:351`).

### 7.2 Recipients (multi-recipient, from `EmailTagField`)

- Recipients come from the Schedule step's `EmailTagField` (`CampaignBuilder.tsx:347`), a multi-email
  token input (`components/common/EmailTagField.tsx`) that validates `/.+@.+\..+/` and de-dups
  client-side. Default seed is `['marketing@evahome.com']`.
- The list is persisted on the campaign/bundle-campaign row at publish and copied into
  `notification.recipients` (JSON array) at send time.
- A campaign with an **empty** recipient list is valid — the status transition still happens; the
  notification is simply skipped (recorded as `status = 'sent'` with zero recipients, or not created).
  Never block activation on a missing email list.

### 7.3 Provider choice — **OPEN DECISION**

Cloudflare Workers have no built-in SMTP. A transactional email mechanism must be selected; this is
flagged as an open decision for E9-4, not assumed:

- **Options:** a transactional email API (Resend / Postmark / SendGrid / Mailgun) called over
  `fetch` from the Worker; or Cloudflare Email Routing's send binding (`send_email`) if a verified
  domain is acceptable. Recommendation leans to a transactional API for deliverability + templating,
  but the choice is deferred to implementation.
- Whichever is chosen: the provider **API key is a Worker secret** (`wrangler secret put`), read from
  `env` at send time — never embedded in a cron event or persisted. Consistent with the no-secrets
  rule.
- Add the provider key to `src/types/env.d.ts` (`Env`) and to the secrets list in `src/CLAUDE.md`.

### 7.4 Templating

- Two minimal templates: **activated** and **deactivated**. Each renders: campaign name, kind
  (campaign vs bundle campaign), window (start/end in the shop's timezone — §10), the count of
  discounts/bundles affected, and a deep link into the app's campaign detail (E8-7).
- Templates are plain interpolated HTML/text held in `src/cron/notify.ts` (or a small
  `src/cron/templates/` module) — no external template engine, self-contained, matching the
  "self-contained Worker" posture.
- Send failures set `notification.status = 'failed'` with `error` populated and are retried on the
  next pass (bounded by `attempts`) — the status transition is **not** rolled back (email is
  best-effort; the campaign is genuinely live).

---

## 8. Issue breakdown

### E9-1 — Cron trigger + `wrangler.jsonc` config; background token refresh

**What.** Wire the platform trigger and the `scheduled()` entry point, with per-shop offline-token
resolution in a background (no-JWT) context.

- Replace the commented example in `wrangler.jsonc` with `"triggers": { "crons": ["*/5 * * * *"] }`.
- Add the `scheduled(event, env, ctx)` export to `src/index.ts` next to `fetch`; set up Drizzle
  (`setDb(env.DB)`) and `ctx.waitUntil(runSchedulingPass(env))`.
- Scaffold `src/cron/runSchedulingPass.ts` with the installed-shop loop, per-shop try/catch, and
  `getShopAccessToken` fetched only when due work exists (§5.3). Loud log + skip on `null` token.
- Add `src/cron/clock.ts` injectable-now (§9).

**Acceptance criteria.**
- `wrangler dev --test-scheduled` (or `curl .../__scheduled`) triggers a pass locally.
- A shop with due work and a valid session gets its token via `getShopAccessToken`; a shop with no
  session is logged and skipped, and the pass continues to other shops.
- No token/secret appears in any cron event payload, queue message, or persisted row.
- One shop throwing does not abort the whole pass.

**Files touched.** `wrangler.jsonc` (crons trigger), `src/index.ts` (`scheduled` export),
`src/cron/runSchedulingPass.ts` (new), `src/cron/clock.ts` (new), `src/CLAUDE.md` (document the wired
cron).

---

### E9-2 — Activation pass

**What.** Bring due `Scheduled` campaigns and bundle campaigns live (§5.4).

- `src/cron/activate.ts`: status-guarded queries for `startsAt <= now`.
- Campaigns (all plans): activate owned discounts + (re)write `$app:` DISCOUNT metafields via the
  E1-3 GraphQL client; `status → Active`, stamp `activatedAt`.
- Bundle campaigns (**Plus only**, gate on `shopify_shop.plan`): write `$app:cart_transform` from
  per-bundle price/compare-at, honoring the 10 KB cap (fail loudly if exceeded); `status → Active`.
- Enqueue "activated" notifications (handed to E9-4).

**Acceptance criteria.**
- A campaign with `startsAt` in the past and `Scheduled` status becomes `Active`, its discounts read
  `ACTIVE` in Shopify, and it is not re-activated on the next pass.
- A bundle campaign on a **Plus** shop writes the `$app:cart_transform` metafield with the editor's
  price/compare-at values; on a **non-Plus** shop it is skipped with a logged reason and stays
  `Scheduled`.
- Immediate-on-publish campaigns (`startsAt = publish time`) activate on the first pass after publish.
- Re-running the pass produces no duplicate GraphQL writes and no status regressions (idempotent).

**Files touched.** `src/cron/activate.ts` (new), `src/cron/publishDiscounts.ts` (new, shared with
E8-5), `src/cron/cartTransformMetafield.ts` (new, shared with E7-3), `src/db/schema.ts` (read E7/E8
status/schedule columns).

---

### E9-3 — Deactivation pass

**What.** Tear down expired `Active` campaigns/bundle campaigns (§5.5).

- `src/cron/deactivate.ts`: status-guarded query for `Active` AND `endsAt <= now`.
- Campaigns: deactivate owned discounts (→ `DISABLED`).
- Bundle campaigns: **clear** the `$app:cart_transform` metafield so the Cart Transform stops firing.
- `status → Ended`, stamp `endedAt`; enqueue "deactivated" notifications.

**Acceptance criteria.**
- A campaign past `endsAt` moves `Active → Ended`, its owned discounts read `DISABLED`, and it is not
  re-processed next pass.
- A bundle campaign past `endsAt` has its `$app:cart_transform` metafield cleared; the storefront
  Cart Transform no longer applies campaign pricing.
- Campaigns with no `endsAt` are never deactivated.
- Idempotent under re-run / overlap.

**Files touched.** `src/cron/deactivate.ts` (new), `src/cron/publishDiscounts.ts`,
`src/cron/cartTransformMetafield.ts`.

---

### E9-4 — Email notifications on activate/deactivate

**What.** Multi-recipient transactional email at both trigger points, with a send log and de-dup.

- `notification` D1 table + Drizzle migration (§6.1).
- `src/cron/notify.ts`: build recipient list from stored `EmailTagField` value; render
  activated/deactivated templates; send via the selected provider (§7.3 — resolve the open decision
  here); write `notification` send-log rows keyed `(shopId, campaignId, event)`; retry `failed` on
  subsequent passes.
- Provider API key added as a Worker secret and to `Env`.

**Acceptance criteria.**
- On activation and on deactivation, every recipient in the campaign's notify list receives one
  email; the send is logged `sent`.
- A retried/overlapping pass does **not** send a second email for the same `(campaignId, event)`.
- A provider error records `status = 'failed'` + `error` (loud, not swallowed) and retries next pass,
  without rolling back the campaign's status transition.
- An empty recipient list does not block the status transition.
- Provider secret is read from `env` at send time; it appears in no event/message/row.

**Files touched.** `src/cron/notify.ts` (new), `src/cron/templates/` (new, optional),
`src/db/schema.ts` (`notification` table), `drizzle/migrations/*` (new migration),
`src/types/env.d.ts` (provider key on `Env`), `src/CLAUDE.md` (secrets list), `wrangler.jsonc`
(if a `send_email` binding is chosen instead of an API).

---

## 9. Testing

- **Deterministic time injection.** All "now" reads go through `src/cron/clock.ts` (a `now()`
  function, overridable in tests) — never `new Date()` inline. Tests set `now` to just-before and
  just-after each window boundary and assert the exact transition (`Scheduled→Active`,
  `Active→Ended`, no-op inside/outside the window).
- **Activation idempotency.** Run the activation pass twice against the same fixtures with a mocked
  GraphQL client; assert the discount-activate mutation and metafield write fire **once** (second
  pass is a no-op because status is already `Active`), and no duplicate `notification` row is created.
- **Deactivation idempotency.** Same, for `Active→Ended`: metafield clear fires once, discounts
  disabled once, one "deactivated" notification.
- **Plan gate.** Bundle-campaign activation on a non-Plus fixture writes **no** metafield and leaves
  status `Scheduled`; on Plus it writes the metafield.
- **Token failure.** `getShopAccessToken` mocked to return `null` → the shop is skipped, logged, and
  no GraphQL/email side effects occur; other shops in the same pass still process.
- **Notification de-dup.** Pre-seed a `sent` `notification` row for `(campaignId, 'activated')`; the
  pass must not re-send.
- **10 KB cap.** A bundle-campaign config serializing over 10 KB fails loudly (throws, logs, leaves
  `Scheduled`) rather than truncating.
- Unit tests via Vitex/Vitest (`npm test`); the `scheduled` handler exercised via
  `wrangler dev --test-scheduled` / `unstable_dev` in an integration test.

---

## 10. Risks / open questions

- **Cron overlap / long runs.** A pass that runs longer than the 5-minute interval could overlap the
  next fire. Mitigation: status-guarded, idempotent queries (§5.6) make overlap safe; additionally
  consider a per-shop soft lock (KV flag with TTL) or capping shops-per-pass and paginating across
  passes if shop count grows. Keep per-shop work bounded; move heavy fan-out to a queue (E1-6
  scaffold) if a single pass approaches the Worker CPU/subrequest ceiling — still fetching tokens at
  processing time, never through the message.
- **Timezone: AEST vs shop tz.** The prototype authors windows and labels them "AEST"
  (`CampaignBuilder.tsx:406`, `BundleCampaignEditor.tsx:183`), but `shopify_shop.ianaTimezone` is the
  real per-shop zone. **Open decision:** store schedule boundaries as UTC (converted from the shop's
  IANA zone at save time) so the cron compares UTC-to-UTC and is DST-correct; the UI keeps showing
  the shop-local label. Do **not** hardcode AEST in the backend — that would misfire for non-AU shops
  and across DST. Fail loudly if a shop has no `ianaTimezone` rather than assuming one.
- **Email provider selection (§7.3).** Unresolved — transactional API vs Cloudflare Email Routing
  send binding. Blocks E9-4 implementation; affects deliverability, cost, and template capabilities.
- **At-least-once semantics.** Cron triggers are best-effort and may fire late, be skipped under
  platform pressure, or (with retries) fire more than once. Design assumes at-least-once: every
  effect is idempotent and every notification is de-duped. A **missed** pass self-heals — the next
  pass re-selects any still-due `Scheduled`/expired `Active` rows, so activation/deactivation is
  eventually-consistent within one interval of the boundary (the "≤ 5 min" promise holds as an upper
  bound, not an exact-time guarantee). This tolerance should be reflected in merchant-facing copy if
  precise-to-the-second activation is ever expected.
- **Discount count ceiling.** Activating many campaign-owned discounts at once can approach Shopify's
  25-active-function-discounts limit (master §4) and interacts with E11 reconcile. The activation
  pass should surface (log/notify) when an activation would exceed the limit rather than failing
  opaquely.
- **Partial failure within a campaign.** If some owned discounts activate and one mutation fails, the
  campaign should not be marked `Active` prematurely. Open question: all-or-nothing per campaign
  (leave `Scheduled`, retry next pass) vs partial-progress with a resumable marker. Recommendation:
  fail loudly, leave `Scheduled`, retry — consistent with idempotency.
```
