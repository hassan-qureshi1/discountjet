# E8 — Campaigns (Slice 1: build, publish, schedule)

**Date:** 2026-09-27
**Epics:** E8 — Campaigns (#10), E9 — Campaign scheduling (#11)
**Supersedes** parts of `2026-08-25-e08-campaigns-design.md` and `2026-08-25-e09-scheduling-cron-design.md` — see §3.
**Shopify plan:** All. The Bundles step is Plus-only, inherited from E6.
**Depends on:** the merged E5 work — `POST /api/discounts`, `DiscountEngineAdapter`, `resolveDiscountFunctionId` — and the merged bundle scheduling cron.

---

## 1. Summary

A **campaign** groups discounts and bundles onto one schedule. The merchant builds it in a
four-step wizard — **Discounts → Bundles → Schedule → Summary** — and publishes it. Publishing
creates the discounts in Shopify and stamps the campaign's window onto every member.

The central idea, and the reason this slice is small:

> A campaign has **no runtime behaviour of its own**. It is a window applied at publish time to
> two mechanisms that already schedule themselves.

| Member | Scheduled by | Mechanism |
|---|---|---|
| Discounts | **Shopify, natively** | the campaign window becomes the discount's own `startsAt`/`endsAt` |
| Bundles | **our existing cron** | the campaign window becomes the bundle's `scheduleStart`/`scheduleEnd` |

Both fire at the same instant because both carry the *same two timestamps*. Nothing coordinates
them at runtime, so nothing can drift.

## 2. What already exists

- **The create path.** `POST /api/discounts` serialises the `$app:` config through a
  `DiscountEngineAdapter`, resolves `functionId` by extension handle, sends `discountClasses`, and
  creates automatic or code discounts. Verified end to end against a live store.
- **Native discount scheduling.** A discount created with a future `startsAt` comes back
  `status: SCHEDULED` and activates itself. Verified — this is what removes the cron from the
  discount path entirely.
- **Bundle scheduling.** `bundle.scheduleStart`/`scheduleEnd`, `DueBundleScanner`, and the
  `*/5 * * * *` pass that writes and clears cart-transform metafields on the boundary. Verified.
- **The ownership hook.** `discount.campaignId` already exists, commented "Ownership lock, written
  by campaigns (E8)".

## 3. Decisions that supersede the 2026-08-25 specs

| Topic | 2026-08-25 said | This spec | Why |
|---|---|---|---|
| Activating discounts | E9's cron creates/enables scheduled discounts | Created at publish with the campaign's window; **Shopify** activates them | Verified: Shopify schedules them natively. A cron that re-does this adds a failure mode and buys nothing. |
| Activating bundles | E9's cron writes `$app:cart_transform` for campaign bundles | The campaign stamps `scheduleStart`/`scheduleEnd`; the **existing** bundle cron activates them | One activation mechanism, already built and tested, rather than a second that could disagree with it. |
| Campaign status | Cron writes `Scheduled → Published → Ended` | **Derived** from the window on read | Nothing to write means nothing to be stale. |
| `campaign_bundle.metafieldState` | A column mirroring activation | **Dropped** | `bundle.metafieldState` already tracks exactly this. Two copies would disagree. |
| `buildMethod`, `templateId`, `notifyEmails` | Columns on `campaign` | **Dropped** | CSV import, campaign templates and email notifications are out of this slice; columns with no writer are dead weight. A later migration adds them. |
| `revenue`, `orders`, `discountAllocated` | Nullable metric columns | **Dropped** | Sourced from E12, which does not exist. Same reasoning. |

**Consequence worth stating plainly: this slice adds no cron code at all.** E9's campaign half
reduces to the scheduling that E5's and the bundle branch's work already performs.

## 4. Data model

Three tables, all shop-scoped with a non-null `shopId` FK and `onDelete: 'cascade'`, each with a
repository extending `ShopScopedRepository`. `docs/erd.dbml` is updated in the same commit as the
`schema.ts` edit and the generated migration.

### 4.1 `campaign`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK → `shopify_shop.id` cascade | tenancy |
| `name` | `text` NOT NULL | internal |
| `description` | `text` | internal, optional |
| `status` | `text` NOT NULL | `Draft` \| `Scheduled` \| `Published` \| `Ended` |
| `scheduleMode` | `text` NOT NULL | `immediate` \| `window` |
| `startsAt` | `text` | normalized UTC ISO-8601; null when immediate |
| `endsAt` | `text` | normalized UTC ISO-8601; null when immediate or open-ended |
| `publishedAt` | `text` | when the merchant published; null while `Draft` |
| `createdAt`, `updatedAt` | `text` NOT NULL | ISO-8601 |

Index: `campaign_shop_status_idx` on `(shop_id, status)` — the list page's status tabs.

**Status is `Draft` until published, then derived.** After publishing it is
`deriveStatus(startsAt, endsAt, now)` from `src/lib/scheduleWindow.ts`, with that helper's `Active`
read as **`Published`** to match the prototype's vocabulary. The stored value is refreshed whenever
a campaign is read; it is a cache of the derivation, never an independent source of truth. An
`immediate` campaign has a null `startsAt`, which `deriveStatus` already treats as "live now".

### 4.2 `campaign_discount`

The authored discount: its config before publish, its Shopify identity after.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK cascade | tenancy |
| `campaignId` | `text` NOT NULL FK → `campaign.id` cascade | owner |
| `name` | `text` NOT NULL | discount name; becomes the Shopify title |
| `type` | `text` NOT NULL | `tier` \| `bundle` \| `special` — the engine, matching `DiscountEngineType` |
| `method` | `text` NOT NULL | `automatic` \| `code` |
| `code` | `text` | required when `method = 'code'`; the discount's title, per E5's rule |
| `configJson` | `text` NOT NULL | the serialized `$app:` metafield value |
| `configBytes` | `integer` NOT NULL | size for the 10 KB meter |
| `shopifyGid` | `text` | the created node id |
| `publishState` | `text` NOT NULL | `pending` \| `created` \| `failed` |
| `publishError` | `text` | message on failure |
| `createdAt`, `updatedAt` | `text` NOT NULL | ISO-8601 |

Index: `campaign_discount_campaign_idx` on `campaign_id`.

`type` uses the lowercase engine names rather than the prototype's `Tier`/`Bundle`/`Special`, so it
matches `DiscountEngineType` and the existing `discount.type` enum. One vocabulary, not two.

### 4.3 `campaign_bundle`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()` |
| `shopId` | `text` NOT NULL FK cascade | tenancy |
| `campaignId` | `text` NOT NULL FK → `campaign.id` cascade | owner |
| `bundleId` | `text` NOT NULL FK → `bundle.id` cascade | the included bundle |
| `createdAt`, `updatedAt` | `text` NOT NULL | ISO-8601 |

Unique index `campaign_bundle_unq` on `(campaign_id, bundle_id)` — the same bundle twice in one
campaign is a bug, not a use case.

### 4.4 Changes to existing tables

- **`bundle` gains `campaignId`** (`text`, nullable, FK → `campaign.id`, `onDelete: 'set null'`),
  mirroring `discount.campaignId`. Non-null means a campaign owns this bundle's schedule.
  `set null` rather than `cascade`: deleting a campaign must free its bundles, not delete them.
- **`discount.campaignId`** already exists and needs no change.

## 5. Publish

`POST /api/campaigns/:id/publish`, behind `requireShop`. Refuses anything not `Draft`.

1. Load the campaign with its discounts and bundles. Reject an empty campaign — a campaign with
   nothing in it cannot be published.
2. Normalize the window with `normalizeUtc` and `assertWindowOrder` (`src/lib/scheduleWindow.ts`),
   the same helpers the bundle schedule uses. `immediate` means `startsAt = now`.
3. **For each `campaign_discount`:** create it through the same code path `POST /api/discounts`
   uses — adapter lookup by `type`, `validate`, `serialize`, size check,
   `resolveDiscountFunctionId`, then `discountAutomaticAppCreate` or `discountCodeAppCreate` —
   passing **the campaign's window as the discount's own `startsAt`/`endsAt`**. On success record
   `shopifyGid` and `publishState: 'created'`; on failure record `publishState: 'failed'` and the
   message, and carry on.
4. **For each `campaign_bundle`:** set the bundle's `scheduleStart`/`scheduleEnd` to the campaign's
   window and its `campaignId` to this campaign. Nothing is written to Shopify here — the existing
   cron does that on the boundary, exactly as it does for a merchant-scheduled bundle.
5. Set `publishedAt` and the derived status.

**Partial failure is recorded, not rolled back.** If three of five discounts are created, those
three exist in Shopify and deleting them to "undo" would be a destructive act the merchant did not
ask for. The campaign publishes, the failed rows carry their error, and the detail page shows them.
An explicit retry of the failed rows is out of this slice.

**The publish log is derived, not stored.** `campaign_publish_log` is dropped from this slice:
every line the prototype's log shows is already recoverable from `campaign_discount.publishState`,
`shopifyGid`, `publishError` and the campaign's own timestamps. A table that only restates other
columns is a second source of truth for the same facts. If activation events are later wanted —
which would need a cron sweep this slice does not have — the table comes back with them.

## 6. The ownership lock

Publishing locks what the campaign owns.

- `discount.campaignId` is set on each created discount's mirror row when the
  `discounts/create` webhook syncs it, or on the next reconcile.
- `bundle.campaignId` is set at publish, and while it is set the bundle editor's **Schedule card is
  read-only**, with a banner naming the owning campaign. Without that, a merchant edits a bundle's
  window and silently desynchronises it from the campaign that is supposed to own it.
- A campaign that is not `Draft` is itself read-only. The only way to change it is **clone into a
  new draft**: a new `Draft` campaign with copies of the discount configs and bundle references,
  which publishes as *new* Shopify discounts. The published campaign is never mutated.
- **The lock is derived, not cleared.** A bundle is locked **iff its owning campaign has not
  Ended** — not merely iff `campaignId` is set. This follows from §3: nothing runs when a window
  closes, so nothing would be there to clear the column. Deriving it means an ended campaign's
  bundles unlock themselves the moment the window passes, with no sweep and nothing to go stale.
  `campaignId` stays behind as a record of which campaign last scheduled that bundle, which is
  worth keeping; the bundle's window also stays as the campaign left it, and the merchant is free
  to change it.

  The same rule governs `discount.campaignId`: a discount whose campaign has ended is no longer
  campaign-locked. Shopify has already expired the discount itself at that point, so the lock has
  nothing left to protect.

## 7. API

All behind `requireShop`, all D1 access through repositories.

| Route | Purpose |
|---|---|
| `GET /api/campaigns` | list with derived status and member counts |
| `POST /api/campaigns` | create a `Draft` |
| `GET /api/campaigns/:id` | one campaign with its discounts and bundles |
| `PUT /api/campaigns/:id` | edit a `Draft` — 409 on anything else |
| `DELETE /api/campaigns/:id` | delete a `Draft` — 409 on anything else |
| `POST /api/campaigns/:id/publish` | §5 |
| `POST /api/campaigns/:id/clone` | new `Draft` copy; the only edit path for a published campaign |

## 8. UI

- **`web/Pages/Campaigns.tsx`** at `/campaigns` — status tabs (All / Draft / Scheduled / Published
  / Ended) over an `IndexTable`, with spinner and error `Banner`, and an empty state. Draft rows
  link to the builder; the rest to the read-only detail.
- **`web/Pages/CampaignBuilder.tsx`** at `/campaigns/:id/edit` — four steps:
  1. **Discounts** — add discounts via the E5 template flow or a blank tier form; each row shows its
     engine, method and config size.
  2. **Bundles** — multi-select over the shop's bundles, Plus-gated, with the same non-blocking
     upgrade prompt E6 uses. A bundle already owned by another campaign is not selectable, and the
     reason is shown rather than the row silently missing.
  3. **Schedule** — reuses `components/ScheduleCard`, the same component the bundle editor uses, so
     the two surfaces cannot disagree about what a window means.
  4. **Summary** — what will be created, the combined config size against 10 KB, and a one-way
     warning before **Publish campaign**.
- **`web/Pages/CampaignDetail.tsx`** at `/campaigns/:id` — read-only: locked banner, the discounts
  with their Shopify node ids and per-row publish state, the bundles, the window, and **Clone to
  edit** as the primary action.

Step state lives in the `campaign` row, saved as the merchant advances, so closing the tab mid-build
does not lose the work. The wizard is a view over a draft, not a buffer in front of one.

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Publish a non-`Draft` campaign | `409` |
| Publish an empty campaign | `400`, naming what is missing |
| Invalid or backwards window | `400` from `assertWindowOrder` |
| A discount's config invalid or over 10 KB | `400` before any Admin call, per-row |
| `discountAutomaticAppCreate` fails for one discount | that row is `failed` with its message; the rest continue |
| Function not deployed | `502`, naming the missing function |
| Edit or delete a published campaign | `409` with the clone-to-edit explanation |

No fallback masks a missing token, domain, function id or config.

## 10. Testing

**Unit** — status derivation including `immediate` (null `startsAt`) reading as `Published`, and the
`Active → Published` mapping. Lock derivation: a bundle whose campaign is `Ended` is unlocked, one
whose campaign is `Scheduled` or `Published` is locked, and one with no `campaignId` is unlocked.

**Repository** — the three repositories against the recording fake D1: every read and write scoped
by `shop_id`; `campaign_bundle_unq` prevents duplicates.

**Route** — publish creates one discount per row carrying **the campaign's window** as the
discount's `startsAt`/`endsAt`; publish stamps each bundle's `scheduleStart`/`scheduleEnd` and
`campaignId`; a failing discount marks only its own row and the others still create; publishing a
non-draft is a 409; an empty campaign is a 400; clone produces a `Draft` with copied configs and no
`shopifyGid`.

**Integration** — a published campaign's bundles are picked up by the existing `DueBundleScanner`
when the window opens, proving the two halves meet.

## 11. Out of scope

- CSV import and its column contract.
- Campaign templates (E8-8).
- Email notifications (E9-4) — no provider exists; its own subsystem.
- Campaign metrics (revenue / orders / discount allocated) — sourced from E12.
- Retrying an individual failed discount after publish.
- Bundle campaigns (E7), which are a separate surface from campaigns.
