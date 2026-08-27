# E8 — Campaigns

**Date:** 2026-08-25
**Status:** Design spec — ready for `superpowers:writing-plans`
**Epic:** E8 — Campaigns
**Required Shopify plan:** All (the **Bundles step is Plus-only**, inherited from E6)
**Depends on:** E3 (discount authoring wizard + `discountAutomaticAppCreate` create path), E6 (Cart Transform bundles + Plus plan gating)
**Relates to:** E9 (scheduling cron activates/deactivates campaigns and sends notify emails), E4 (discount mirror + list where locked discounts render), E12/E4 (metric aggregation source)
**Issues:** E8-1 … E8-8 (master decomposition §7)

---

## Summary

A **campaign** groups a set of discounts and (on Plus) bundles onto a single schedule, then
**publishes** them to Shopify in one orchestrated operation. Publishing creates each discount via
the GraphQL Admin API (`discountAutomaticAppCreate`), writes the `$app:` config metafields, and
records a **publish log**. Campaign-created discounts are **owned and locked** to the campaign
(`campaignId` set) — read-only everywhere in the app; the only way to change a published campaign
is to **clone it into a new draft and republish**.

The builder is a **5-step wizard** — Details / Discounts / Bundles / Schedule / Review — and
supports three build methods: manual, start-from-template, and **CSV import** with a documented
column contract. Scheduling (time-based activation/deactivation) is delegated to the **E9 cron**;
email notifications on activate/deactivate are delivered by **E9-4** using the multi-recipient
`EmailTagField` recipients captured on the Schedule step.

This epic ports the existing prototype (list, builder, detail, templates, all on hardcoded JSON)
onto the real D1 model + GraphQL publish path, without changing the page structure or copy — the
prototype is the design source of truth (master §1, §5).

---

## Current state

The prototype implements the entire campaign surface against hardcoded fixtures and local
component state — no persistence, no Shopify calls:

- **List** — `discount-engine-ui/src/pages/Campaigns.tsx`. Status tabs (All / Draft / Scheduled /
  Published / Ended) with live per-tab counts, an IndexTable with per-campaign metric columns
  (Discounts, Bundles, Revenue, Orders, Discount), Schedule and Status columns, and per-row
  **View/Edit** + **Clone** actions. Draft rows link to `/campaigns/:id/edit`; non-draft rows link
  to the read-only `/campaigns/:id`. A page-level **Import CSV** secondary action is present but
  inert. Subtitle copy already states the contract: "Publishing creates the discounts in Shopify
  via the GraphQL Admin API — once live, a campaign is locked, so clone it to make changes."
- **Builder** — `discount-engine-ui/src/pages/CampaignBuilder.tsx`. 5-step `Stepper`
  (`STEPS = ['Details','Discounts','Bundles','Schedule','Review']`). Details step chooses build
  method (manual / template / **Import from CSV** via `DropZone` with the documented column hint).
  Discounts step opens the **reused E3 discount wizard** (`DiscountSetupForm`) in a `Modal` and
  appends `BuiltDiscount` rows. Bundles step is a multi-select bundle picker modal over
  `useCartTransforms()`. Schedule step chooses immediate vs windowed, captures start/end, and an
  `EmailTagField` for notify recipients. Review step shows a one-way-publish warning banner,
  discount/bundle summary, `$app:cart_transform` metafield reference, and a mock 2.4 kB / 10 kB
  size meter. `publish()` writes a campaign fixture and appends locked discounts
  (`campaignId` set) into the discount store.
- **Detail** — `discount-engine-ui/src/pages/CampaignDetail.tsx`. Locked banner, 5-metric strip,
  discounts table with mock GraphQL `gid://…` node IDs and a "Created via GraphQL" badge, bundles
  card with "Metafield written" badge, schedule card, and a **publish log**
  (discountAutomaticAppCreate, `$app:cart_transform` write, auto-deactivate scheduled). Primary
  action is "Clone to edit".
- **Templates** — `discount-engine-ui/src/pages/CampaignTemplates.tsx` +
  `discount-engine-ui/src/data/campaignTemplates.json` (6 presets with emoji, category, example).
- **Fixtures / types** — `discount-engine-ui/src/data/campaigns.json` (4 sample campaigns);
  `discount-engine-ui/src/types/index.ts` defines `Campaign`, `CampaignStatus`,
  `CampaignTemplate`, and `Discount.campaignId?`.
- **Notify component** — `discount-engine-ui/src/components/common/EmailTagField.tsx` (chip-style
  multi-email token input; validates `.+@.+\..+`, dedupes).

Everything is fixture-backed and inert: no D1 tables, no publish orchestration, no cron wiring, no
CSV parsing. E8 makes it real.

---

## Shopify plan gating

Two axes (master §3): the **merchant's Shopify plan** vs. **Discount Jet's own app tier** (E11).
E8 gating is on the Shopify-plan axis.

- **Campaign of discounts — All plans.** Grouping app/automatic discounts on a schedule and
  publishing them via `discountAutomaticAppCreate` has no Function/plan gate (master §3 matrix:
  "campaigns of discounts" is available on Basic/Shopify/Advanced/Plus). A non-Plus merchant gets
  the full Details / Discounts / Schedule / Review flow.
- **Bundles step — Plus-only (inherits E6).** Bundles are Cart Transform operations
  (`merge`/`expand`/`update`), which are Plus-gated end-to-end (master §3, §7 E6). The **Bundles
  step (E8-4)** must reuse E6's plan detection (`BundlesFeature` / shop plan) and render an
  **upgrade prompt, never a hard failure** (master §3 product rule). On non-Plus stores the step
  is shown disabled/locked with the upgrade CTA; the merchant proceeds with **a campaign that has
  zero bundles**, and publish orchestration simply skips the bundle metafield writes.
- Dev stores unlock cart-transform operations regardless of live plan, so the Bundles step is
  fully exercisable in development (master §3).
- App-tier limits (active discount count, E11) are enforced by the reconcile job, **not** by E8;
  publish should surface a clear error if a publish would exceed the tier limit rather than
  silently succeeding (see Risks).

---

## Architecture

### The 5-step builder

Ported from `CampaignBuilder.tsx`, backed by a `campaign` draft row in D1 (autosaved on "Save
draft"). Steps:

1. **Details** — name, internal description, **build method** (manual / template / CSV import).
   Template choice prefills from a `CampaignTemplate` (E8-8). CSV import reveals the `DropZone` and
   documented column hint, and parsing/preview happens here (E8-6). Nothing is created in Shopify
   at this stage — the campaign is a **draft**.
2. **Discounts** — reuses **E3's discount wizard** (`DiscountSetupForm`) inside a Polaris `Modal`.
   Each added discount is a serialized `BuiltDiscount` (name, type, symbol, product count, plus the
   full E3 config JSON) held as a `campaign_discount` draft row. Discounts authored here are
   **created locked to the campaign** on publish (`campaignId` set → read-only everywhere).
3. **Bundles** (Plus) — multi-select over existing E6 bundles (`useCartTransforms`), stored as
   `campaign_bundle` join rows. Plus-gated per above.
4. **Schedule** — immediate-on-publish vs. a scheduled window (`startsAt` / `endsAt`), plus notify
   recipients via `EmailTagField`. The window and recipients are persisted for the E9 cron.
5. **Review** — one-way-publish warning, discount/bundle summary, serialized metafield size meter
   (real bytes from E3's serializer, reusing the 10 KB cap), and the **Publish campaign** action.

### Ownership-lock model

A campaign **owns** the discounts it authors. On publish, each created discount's mirror row (E4
`discount`) is stamped with `campaignId`. The lock has these consequences everywhere:

- The discount **detail/edit** surfaces (E3-7, E4-3) show a campaign-lock banner and disable
  editing when `campaignId` is set.
- The discounts **list** (E4-2) shows a campaign badge for locked rows.
- Editing a locked discount = **clone-into-draft-and-republish**: the merchant clones the whole
  campaign into a new `Draft` campaign (unlocked copies of the discounts as fresh `BuiltDiscount`
  configs), edits, and publishes — which creates **new** Shopify discounts. The old campaign is
  never mutated in place.
- A published or scheduled campaign is itself **read-only** (list Clone-only, detail
  "Clone to edit"). Only `Draft` campaigns route to `/campaigns/:id/edit`.

### Publish orchestration

On **Publish campaign** (E8-5), the backend runs an ordered orchestration (server-side, not in the
browser — the campaign id + draft rows are the input):

1. Transition campaign `Draft → Publishing` (internal) and open a **publish log** (append-only
   rows on `campaign`, or a child log table — see Data model).
2. For each `campaign_discount`: call **`discountAutomaticAppCreate`** (master §4) with the E2
   `functionId`, `combinesWith`, `discountClasses`, and the **`$app:` `type: json` metafield** the
   E3 serializer produced (respecting the **10 KB cap**). Capture the returned
   `gid://shopify/DiscountAutomaticNode` node id, upsert the E4 `discount` mirror with
   `campaignId` set, and append a publish-log success/failure row. (Code-method discounts, if ever
   added to campaigns, would use `discountCodeAppCreate` — E3-6; the prototype only authors
   automatic discounts.)
3. For each `campaign_bundle` (Plus): write / confirm the bundle's `$app:cart_transform` metafield
   is in the campaign's active set. Actual metafield **write timing** for scheduled campaigns is
   executed by the **E9 activation pass**, not synchronously here (see Scheduling below); the log
   records "scheduled" vs. "written".
4. Set the campaign status: **`Scheduled`** if a future window was chosen, **`Published`** if
   immediate. Record `activated`/auto-deactivate entries in the publish log.
5. On any per-discount failure, record it in the log and follow the partial-failure policy (Risks).

GraphQL calls go through E1-3's typed, cost-aware, retry/backoff Admin client using the offline
token from KV (`getShopAccessToken`) — never a token passed through a queue message (master §5).

### Scheduling & notifications (delegated to E9)

E8 **stores** the schedule (`startsAt`/`endsAt`, immediate flag) and notify recipients; it does
**not** run timers. The **E9 cron** (≤5 min) performs the activation pass (create/enable scheduled
discounts, write bundle metafields), the deactivation pass (clear metafields, deactivate expired
discounts, set campaign `Ended`), and sends **activate/deactivate emails** (E9-4) to the
`EmailTagField` recipients. E8 references E9 rather than duplicating its logic.

---

## Data model

Additive D1 tables (Drizzle), all following the shared conventions (master §5, §6): IDs are
`crypto.randomUUID()`, timestamps are ISO-8601 `text()`, every table carries a non-null
`shopId text` FK → `shopify_shop.id` with `onDelete: 'cascade'`. No `?? ''` fallbacks on required
fields.

### `campaign`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK → `shopify_shop.id` cascade | tenancy |
| `name` | `text` NOT NULL | internal campaign name |
| `description` | `text` | internal, optional |
| `status` | `text` NOT NULL | `Draft` \| `Scheduled` \| `Published` \| `Ended` (matches `CampaignStatus`) |
| `buildMethod` | `text` NOT NULL | `manual` \| `template` \| `csv` |
| `templateId` | `text` | source `CampaignTemplate` id when built from a template (E8-8) |
| `scheduleMode` | `text` NOT NULL | `immediate` \| `window` |
| `startsAt` | `text` | ISO-8601; null when immediate |
| `endsAt` | `text` | ISO-8601; null when immediate |
| `timezone` | `text` | display TZ (prototype shows AEST); store IANA name |
| `activatedAt` | `text` | set by E9 activation pass |
| `deactivatedAt` | `text` | set by E9 deactivation pass |
| `notifyEmails` | `text` (JSON array) | recipients from `EmailTagField` (E9-4 consumes) |
| `revenue` | `real` NULL | metric; **nullable** until computed (source: E12/E4) |
| `orders` | `integer` NULL | metric; nullable |
| `discountAllocated` | `real` NULL | metric ("Discount" column); nullable |
| `createdAt` | `text` NOT NULL | ISO-8601 |
| `updatedAt` | `text` NOT NULL | ISO-8601 |

Metrics are **nullable by design** — a draft/scheduled campaign has no revenue/orders/discount yet
(prototype renders `null` as `—`). They are populated from the analytics source (E12/E4), not
written by the publish path (see Risks).

### `campaign_discount`

Join / authored-discount row. Holds the draft config pre-publish and the created node id
post-publish.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK cascade | tenancy |
| `campaignId` | `text` NOT NULL FK → `campaign.id` cascade | owner |
| `name` | `text` NOT NULL | discount name |
| `type` | `text` NOT NULL | `Tier` \| `Bundle` \| `Special` (`DiscountType`) |
| `symbol` | `text` | display glyph (from `BuiltDiscount`) |
| `productCount` | `integer` NOT NULL | resolved product count |
| `configJson` | `text` NOT NULL | serialized E3 `$app:` metafield JSON (the value written on publish) |
| `configBytes` | `integer` NOT NULL | serialized size for the 10 KB meter (E3-5) |
| `shopifyGid` | `text` | `gid://shopify/DiscountAutomaticNode/…`, set on successful create |
| `discountId` | `text` FK → `discount.id` (E4) | link to the mirror row once synced |
| `publishState` | `text` NOT NULL | `pending` \| `created` \| `failed` |
| `publishError` | `text` | error message on failure |
| `createdAt` / `updatedAt` | `text` NOT NULL | ISO-8601 |

### `campaign_bundle`

Join to an existing E6 bundle (Plus). No config is authored here — bundles are defined in E6.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK cascade | tenancy |
| `campaignId` | `text` NOT NULL FK → `campaign.id` cascade | owner |
| `bundleId` | `text` NOT NULL FK → `bundle`/`cart_transform` (E6) | the included bundle |
| `metafieldState` | `text` NOT NULL | `pending` \| `written` \| `cleared` (mirrors activation) |
| `createdAt` / `updatedAt` | `text` NOT NULL | ISO-8601 |

### `campaign_publish_log`

Append-only audit powering the detail-page publish log (`CampaignDetail.tsx`).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK cascade | tenancy |
| `campaignId` | `text` NOT NULL FK → `campaign.id` cascade | owner |
| `kind` | `text` NOT NULL | `discount_created` \| `discount_failed` \| `metafield_written` \| `metafield_cleared` \| `scheduled` \| `activated` \| `deactivated` |
| `message` | `text` NOT NULL | human line (e.g. "3 discounts created via discountAutomaticAppCreate") |
| `refGid` | `text` | related node id / metafield key |
| `createdAt` | `text` NOT NULL | ISO-8601 |

**Ownership-lock semantics.** A published campaign's `campaign_discount` rows and their E4
`discount` mirrors (`campaignId` set) are read-only. There is no in-place edit path: the campaign
row is immutable once status leaves `Draft`; edits happen only through **clone → new Draft
campaign → publish**, which mints new `campaign`, `campaign_discount`, and Shopify discounts.

---

## CSV import

Selected on the Details step (build method "Import from CSV"), the `DropZone` accepts a single
`.csv`. The documented column contract (already surfaced verbatim in `CampaignBuilder.tsx`) is:

```
campaign, section, type, name, products, value, min_qty, bundle_price, starts_at, ends_at
```

### Column contract

| Column | Applies to | Meaning / rules |
|---|---|---|
| `campaign` | all rows | Campaign name. All rows must share one value → one campaign. |
| `section` | all rows | `discount` \| `bundle`. Routes the row to `campaign_discount` vs `campaign_bundle`. |
| `type` | discount rows | Engine type: `Tier` / `Bundle` / `Special` (or their merchant labels — normalize). Ignored for bundle rows. |
| `name` | all rows | Discount or bundle name. |
| `products` | discount rows | Product handle/count reference resolved via ResourcePicker/handles (E3-7). |
| `value` | discount rows | Percentage or fixed amount driving the config. |
| `min_qty` | discount rows | Threshold for Tier/volume; optional for others. |
| `bundle_price` | bundle rows | Shopper price for the bundle. |
| `starts_at` / `ends_at` | one header row per campaign | ISO-8601 window; blank → immediate. |

### Parsing + validation + preview

- **Parse** the CSV client-side (or via an upload endpoint) into typed rows; header names are
  matched case-insensitively; unknown columns are ignored with a warning.
- **Validate**: exactly one distinct `campaign` value; every row has a valid `section`; discount
  rows have a valid `type` and a numeric `value`; bundle rows have `bundle_price` and reference an
  **existing** E6 bundle (Plus only — on non-Plus, bundle rows are flagged and skipped with an
  upgrade note); dates parse to ISO-8601; each discount's serialized config stays under the 10 KB
  cap (E3-5).
- **Preview**: render the parsed campaign in the same builder summary shape (discount list, bundle
  list, schedule) before anything is written — the merchant lands on the Review step with the
  imported draft. Invalid rows are listed with row numbers and reasons in a Polaris `Banner`;
  import is blocked until they are fixed or dropped.
- No Shopify writes happen at import — a validated CSV produces a **Draft** campaign identical to
  one built manually; publish is still the explicit one-way action on Review.

---

## Issue breakdown

### E8-1 — `campaign` model + list

**What.** Create the `campaign` table (+ `campaign_discount`, `campaign_bundle`,
`campaign_publish_log`) and Drizzle migration. Replace the `campaigns.json` fixture behind
`useCampaigns()` with a live `GET /api/campaigns` query. Port `Campaigns.tsx`: status tabs with
live per-tab counts, metric columns (nullable → `—`), Schedule/Status columns, View/Edit + Clone
row actions.

**Acceptance criteria.**
- Migration creates all four tables with `shopId` FK cascade, UUID PKs, ISO-8601 timestamps.
- List renders from D1 for the current shop only; per-tab badges reflect real counts.
- Draft rows link to `/campaigns/:id/edit`; non-draft rows to `/campaigns/:id`; Clone starts a new
  draft.
- Nullable metrics render as `—`; no `?? ''` masking of missing required fields.
- `/api/campaigns*` protected by `requireShop`.

**Files touched.** `src/db/schema.ts` (+ migration under `src/db/migrations/` or Drizzle output);
`src/routes/campaigns.ts` (new); `discount-engine-ui/src/pages/Campaigns.tsx`;
`discount-engine-ui/src/store/useDiscountStore.ts` (swap `useCampaigns` fixture → API);
`discount-engine-ui/src/types/index.ts` (align `Campaign` with server shape).

### E8-2 — 5-step builder shell

**What.** Port `CampaignBuilder.tsx` onto a persisted draft campaign: Details (name, description,
build method), Stepper navigation, Save-draft (upsert `campaign` + child rows), and the
draft-status metadata. Template and CSV build-method branches wire to E8-8 / E8-6.

**Acceptance criteria.**
- "Save draft" persists the campaign and all child rows and is resumable via `/campaigns/:id/edit`.
- Stepper preserves step state; Back/Next behave as in the prototype.
- Details step captures build method; template selection prefills name/description; CSV branch
  reveals the DropZone + documented column hint.
- Only `Draft` campaigns are editable; opening a non-draft id in the builder redirects to detail.

**Files touched.** `discount-engine-ui/src/pages/CampaignBuilder.tsx`;
`discount-engine-ui/src/store/useDiscountStore.ts` (`useAddCampaign` → API mutation);
`src/routes/campaigns.ts` (draft upsert endpoints).

### E8-3 — Discounts step (reuse wizard + ownership lock)

**What.** Wire the Discounts step's modal to **E3's `DiscountSetupForm`** wizard; persist each
added discount as a `campaign_discount` draft row (config JSON + bytes from E3's serializer).
Establish the ownership-lock contract so that on publish the created discount's E4 mirror is
stamped `campaignId` and rendered read-only.

**Acceptance criteria.**
- Adding a discount reuses the E3 wizard unchanged (Tier/Bundle/Special) and stores the serialized
  `$app:` config + byte size.
- Removing a discount deletes its draft row.
- `campaign_discount.configBytes` respects E3's 10 KB cap; over-cap discounts are blocked with the
  E3 validation banner.
- The lock contract is documented and consumed by E4-2/E4-3/E3-7 (badge + disabled edit) — E8 sets
  `campaignId`; those epics render it.

**Files touched.** `discount-engine-ui/src/pages/CampaignBuilder.tsx`;
`discount-engine-ui/src/components/discount/DiscountSetupForm.tsx` (reuse; no behavior change);
`src/routes/campaigns.ts` (campaign_discount CRUD); shared config-serializer from E3-5.

### E8-4 — Bundles step (multi-select, Plus-gated)

**What.** Port the multi-select bundle picker over existing E6 bundles into `campaign_bundle` join
rows. Gate the step on Plus using E6's plan detection; show an upgrade prompt (never a hard fail)
on non-Plus and allow the merchant to continue with zero bundles.

**Acceptance criteria.**
- On Plus, the picker lists the shop's E6 bundles; selected bundles persist as `campaign_bundle`
  rows; already-added bundles are excluded from the picker.
- On non-Plus (and not a dev store), the step renders a disabled/locked state with the E6 upgrade
  CTA; publish proceeds with no bundles.
- Removing a bundle deletes its join row.

**Files touched.** `discount-engine-ui/src/pages/CampaignBuilder.tsx`;
`discount-engine-ui/src/store/useDiscountStore.ts` (`useCartTransforms` → API);
E6 plan-detection hook/util (reused); `src/routes/campaigns.ts` (campaign_bundle CRUD).

### E8-5 — Publish orchestration

**What.** Implement the server-side publish path: create each `campaign_discount` via
`discountAutomaticAppCreate` (E1-3 client) with metafields, capture node ids, upsert E4 mirrors
with `campaignId`, write the publish log, set the campaign to `Scheduled`/`Published`, and hand
scheduled activation/deactivation to E9. Enforce the partial-failure policy.

**Acceptance criteria.**
- Publish is a single server operation keyed to the campaign id; discounts are created via
  `discountAutomaticAppCreate` with the correct `functionId`, `combinesWith`, `discountClasses`,
  and `$app:` `type: json` metafield (≤10 KB).
- Each created discount's returned `gid://shopify/DiscountAutomaticNode` is stored; the E4 mirror is
  stamped `campaignId` (locked).
- A `campaign_publish_log` entry is written per step (created / failed / metafield / scheduled).
- Immediate campaigns → `Published`; windowed → `Scheduled` with E9 handling activation; bundle
  metafield writes are recorded as `scheduled` and executed by E9's activation pass.
- Partial failures are recorded and surfaced per the chosen policy (Risks); the campaign is never
  left in an ambiguous `Publishing` state.
- Uses the offline token from KV via `getShopAccessToken`; no secrets in queue messages.

**Files touched.** `src/routes/campaigns.ts` (publish endpoint / queue trigger);
`src/services/publishCampaign.ts` (new orchestration);
`src/services/graphql/*` (E1-3 client, `discountAutomaticAppCreate`);
`discount-engine-ui/src/pages/CampaignBuilder.tsx` (`publish()` → API call).

### E8-6 — CSV import

**What.** Implement CSV parsing, validation, and preview for the documented column contract; land
the result as a Draft campaign in the builder Review step. Wire the page-level and Details-step
Import CSV entry points.

**Acceptance criteria.**
- The `DropZone` accepts a `.csv`; headers are matched case-insensitively against the documented
  columns; unknown columns warn and are ignored.
- Validation enforces one campaign name, valid `section`/`type`, numeric `value`/`bundle_price`,
  existing bundle references (Plus only), parseable dates, and per-discount ≤10 KB config.
- Invalid rows are reported by row number + reason and block import until resolved.
- A valid import produces a Draft campaign (no Shopify writes) and drops the merchant on the Review
  step; publish remains the explicit one-way action.

**Files touched.** `discount-engine-ui/src/pages/CampaignBuilder.tsx`;
`discount-engine-ui/src/lib/campaignCsv.ts` (new parser/validator);
`discount-engine-ui/src/pages/Campaigns.tsx` (page-level Import CSV action → builder CSV mode).

### E8-7 — Campaign detail + publish log + clone-to-edit

**What.** Port `CampaignDetail.tsx` onto live data: locked banner, metric strip (nullable-safe),
discounts table with real GraphQL node ids and status, bundles card with metafield state, schedule
card, and the **publish log** rendered from `campaign_publish_log`. Implement **Clone to edit** →
new Draft campaign with unlocked discount configs.

**Acceptance criteria.**
- Detail renders discounts, bundles, schedule, and publish log from D1 for the current shop.
- Node ids shown are the real `gid://shopify/DiscountAutomaticNode/…` values captured at publish.
- "View in Shopify" deep-links via the node id; page is read-only.
- "Clone to edit" creates a new `Draft` campaign copying discount configs as fresh
  (`campaignId`-unset) `BuiltDiscount` drafts and bundle selections, then routes to
  `/campaigns/:id/edit`.

**Files touched.** `discount-engine-ui/src/pages/CampaignDetail.tsx`;
`discount-engine-ui/src/store/useDiscountStore.ts` (`useCampaign` → API + clone mutation);
`src/routes/campaigns.ts` (detail + clone endpoints).

### E8-8 — Campaign templates gallery

**What.** Serve `campaignTemplates.json` presets (registry, keep as static data or a `GET
/api/campaign-templates` endpoint) and wire "Use template" / "Add from template" to prefill the
builder (Details build method = template, `templateId` recorded).

**Acceptance criteria.**
- Templates gallery (`CampaignTemplates.tsx`) and the builder's template modal render from the
  registry.
- Selecting a template prefills name/description and sets `buildMethod = template`, `templateId`.
- A template can seed default discount/bundle rows for the campaign draft (where the preset defines
  them) that the merchant can then edit before publish.

**Files touched.** `discount-engine-ui/src/pages/CampaignTemplates.tsx`;
`discount-engine-ui/src/pages/CampaignBuilder.tsx` (template modal + prefill);
`discount-engine-ui/src/data/campaignTemplates.json`;
`discount-engine-ui/src/store/useDiscountStore.ts` (`useCampaignTemplates`).

---

## Testing

- **Migration** — `campaign`, `campaign_discount`, `campaign_bundle`, `campaign_publish_log` apply
  cleanly; `shopId` cascade delete removes all campaign rows on `shop/redact` (GDPR).
- **List/tabs** — per-tab filtering and counts match seeded rows; nullable metrics render `—`;
  cross-shop isolation (a second shop sees none of the first shop's campaigns).
- **Builder draft** — save-draft round-trips through `/campaigns/:id/edit`; step state and all
  child rows persist; non-draft ids redirect to detail.
- **Discounts step** — E3 wizard produces a `campaign_discount` with correct config JSON + bytes;
  over-cap config is blocked by the E3 banner.
- **Bundles step gating** — Plus store lists bundles and persists join rows; non-Plus store shows
  upgrade prompt and publishes zero bundles; dev store behaves as Plus.
- **Publish orchestration** — mock Admin client: verify `discountAutomaticAppCreate` payloads
  (functionId/combinesWith/discountClasses/metafield), node-id capture, E4 mirror `campaignId`
  stamping, publish-log rows, and immediate-vs-windowed status transition. Test **partial failure**
  (one discount create fails) against the chosen policy.
- **Ownership lock** — a published campaign's discounts are read-only in list/detail/edit; clone
  produces unlocked draft copies and never mutates the original.
- **CSV import** — golden valid CSV → correct Draft campaign; malformed CSVs (multiple campaign
  names, bad section/type, non-numeric value, missing bundle, unparseable dates, over-cap config)
  each produce the expected row-level error and block import.
- **Templates** — selecting each preset prefills the builder and records `templateId`.

---

## Risks / open questions

- **Publish partial failure / rollback.** `discountAutomaticAppCreate` is per-discount; a campaign
  with N discounts can fail on discount k. Options: (a) **best-effort** — keep the k−1 created,
  mark the campaign `Published` with failed rows flagged in the log and a retry action; (b)
  **all-or-nothing** — best-effort delete the created discounts on any failure and leave the
  campaign `Draft`. Shopify has no cross-discount transaction, so true atomicity is impossible;
  recommend (a) with an explicit **Retry failed discounts** action and a clearly-labeled publish
  log. Decision needed before E8-5.
- **One-way publish.** By design a published/scheduled campaign is immutable (clone-to-edit only).
  This is a deliberate product constraint matching the prototype copy, but merchants may expect to
  extend a window or add a discount in place — confirm we accept clone-only, or add a narrow
  "extend schedule" escape hatch that only touches `startsAt`/`endsAt` (which E9 already reads)
  without re-creating discounts.
- **Metric computation source.** `revenue` / `orders` / `discountAllocated` are nullable and **not**
  produced by the publish path. The source is analytics (E12) built on the E4 discount mirror +
  order/usage data. Open question: are these computed from Shopify order webhooks / discount usage
  (needs additional scopes + a `webhook_event`-backed aggregation) or from Shopify's discount
  analytics API? Until E12 lands, campaign metrics stay `—`.
- **Bundle metafield write timing.** For scheduled campaigns, bundle `$app:cart_transform`
  metafield writes must happen at the E9 activation pass, not at publish — but E6 allows only **one
  cart transform per app per store**, so overlapping campaigns that both include bundles could
  contend for the same transform's active config. Need a rule for how concurrently-active campaigns
  compose their bundle sets (owned by E6/E7; E8 must not double-write). 
- **App-tier limit interaction (E11).** A publish that would push the active discount count over
  the app tier's limit must fail loudly with an upgrade prompt rather than creating discounts the
  reconcile job will immediately deactivate. Confirm E8-5 pre-checks the E11 `plan_state` count.
