# Bundle scheduling — activate a bundle over a UTC date/time window

**Date:** 2026-09-27
**Epic:** E6 (cart-transform bundles) — scheduling
**Shopify plan:** All (`update`-operation bundles remain Plus-gated, on the cron path too)
**Depends on:** E6 (bundles, cart-transform metafields), E1 (Admin GraphQL client, offline-token refresh)
**Related:** `2026-08-25-e09-scheduling-cron-design.md` (campaign scheduling — a separate, later sweep that shares this cron trigger)

---

## 1. Summary

A merchant sets a start and/or end datetime on a bundle. The bundle turns on and off at
checkout automatically at those boundaries, without anyone touching it.

Enforcement is real, not cosmetic: a Cloudflare Cron Trigger firing every 5 minutes writes the
bundle's cart-transform metafield when its window opens and clears it when the window closes.
Outside its window a scheduled bundle has no metafield, so the Rust cart transformer does not
see it and checkout prices it as an ordinary product.

Times are picked in the merchant's browser-local timezone, converted to UTC on the client,
stored as normalized UTC ISO-8601 strings, and converted back to local for display.

## 2. Current state

- `bundle.scheduleStart`, `bundle.scheduleEnd` and `bundle.status`
  (`Active | Scheduled | Ended | Draft`) already exist in `src/db/schema.ts` and are **dead**:
  `src/routes/bundles.ts` always stores `scheduleStart: null` / `scheduleEnd: null`, and the
  editor hardcodes `status` to `Active`.
- Enforcement today is driven by `operation`, never by `status`:
  - `expand` → variant metafield `$app:cart-transform.composition` (`writeComposition` /
    `clearComposition`)
  - `merge` → **shop-level** metafield `$app:cart-transform.merge_bundles`, an array of all
    merge bundles (`upsertMergeConfig` / `removeMergeConfig`)
  - `update` → no metafield transport at all
- The Rust cart transformer (`extensions/cart-transformer/`) has no notion of time and is
  **not modified by this work**.
- No cron trigger is enabled — `triggers.crons` is commented out in `wrangler.jsonc` and there
  is no `scheduled` export in `src/index.ts`.

## 3. Decisions

| Question | Decision |
|---|---|
| What changes at the boundary? | The metafield is written/cleared by a cron pass. ≤5 min granularity is acceptable. |
| Whose clock does the merchant type in? | The browser's local zone; converted to UTC client-side, rendered back to local. |
| Which window shapes are valid? | All four: start-only, end-only, both, neither. |
| Who owns status? | The schedule. `Draft` is the merchant's manual off-switch and never activates. |
| How does the cron find due rows? | One narrow unscoped id-only scan, then all real work through scoped repositories. |
| Cron cadence | `*/5 * * * *`, consistent with the "≤ 5 min" copy the E9 campaign spec already promises. |

**Known limitation, accepted:** if the merchant's browser is in a different timezone from the
store, the window is set in the *browser's* zone. The editor mitigates this by printing the
resolved local time and zone abbreviation beneath each field, so the value is never ambiguous
on screen. A per-bundle timezone picker is out of scope.

## 4. Data model

No new columns for the window itself — the existing `schedule_start` / `schedule_end` /
`status` columns are brought to life.

### 4.1 Storage format (hard invariant)

Both columns hold a normalized UTC ISO-8601 string: `2026-10-03T09:00:00.000Z`. Always produced
via `new Date(input).toISOString()`, always fixed-width, always `Z`-suffixed.

This is what makes lexicographic string comparison in SQLite identical to chronological
comparison, which is what lets the due-scan use plain `WHERE schedule_start <= ?` predicates
with no SQLite date functions and a usable index.

An unparseable value is a `400` at the route. It is never stored as `null` — masking a bad
input as "no schedule" would silently make a bundle permanently live.

### 4.2 Status is derived, then persisted

```ts
function deriveStatus(start: string | null, end: string | null, now: string): BundleStatus {
  if (end   !== null && now >= end)   return 'Ended';
  if (start !== null && now <  start) return 'Scheduled';
  return 'Active';
}
```

`Draft` is outside this function: it is the merchant's manual off-switch, and rows with
`status = 'Draft'` are never selected by the cron and never derived over.

All four window shapes fall out of these two lines without per-shape branching:

| start | end | now | derived |
|---|---|---|---|
| — | — | any | `Active` |
| set | — | before start | `Scheduled` |
| set | — | after start | `Active` |
| — | set | before end | `Active` |
| — | set | after end | `Ended` |
| set | set | before start | `Scheduled` |
| set | set | inside | `Active` |
| set | set | after end | `Ended` |

The **persisted** `status` records what has actually been done to Shopify (metafield written or
cleared). The **derived** status is what should be true now. The gap between the two is the
cron's work queue — which is also why the scan query is expressible as two indexed predicates.

### 4.3 Schema changes

New column on `bundle`:

| column | type | note |
|---|---|---|
| `schedule_error` | `text` nullable | Last failed-transition message. Set on failure, cleared to `null` on success. Surfaced in the UI as a warning `Banner`. |

New indexes on `bundle`:

| index | columns | serves |
|---|---|---|
| `bundle_due_start_idx` | `(status, schedule_start)` | activation: `status='Scheduled' AND schedule_start <= now` |
| `bundle_due_end_idx` | `(status, schedule_end)` | deactivation: `status='Active' AND schedule_end <= now` |

Both are deliberately **not** `shop_id`-leading: the due-scan is cross-shop, and a
`shop_id`-leading index would not serve it.

`docs/erd.dbml` is updated in the same commit as the `schema.ts` edit and the generated
migration, per the root `CLAUDE.md` rule.

### 4.4 Validation

- Both bounds present → `start < end`, else `400`.
- A window entirely in the past is **allowed**. It derives straight to `Ended`, which is the
  honest answer rather than an error.

## 5. The cron pass

### 5.1 Trigger and wiring

- `wrangler.jsonc`: enable `"triggers": { "crons": ["*/5 * * * *"] }`.
- `src/index.ts`: add a `scheduled` export beside the existing `fetch`. It delegates immediately
  to `src/lifecycle/bundleSchedule.ts` — `index.ts` stays a wiring file.

### 5.2 Step 1 — the due scan (one unscoped query)

New `DueBundleScanner` in `src/db/repositories/`, documented at its definition as an escape
hatch in the same voice as `WebhookEventRepository`, and exposing exactly one method:

```ts
findDue(now: string): Promise<Array<{ shopId: string; bundleId: string; to: 'Active' | 'Ended' }>>
```

It runs the two §4.3 predicates as a `UNION ALL` and returns **identifiers only** — no names,
prices, items, or metafield GIDs. `now` is a parameter, not read inside, so tests drive the
clock rather than mocking it.

`to` is an **advisory hint**, not a decision. Once the row is re-read through the scoped
repository (§5.3) the target status is recomputed with `deriveStatus` and that result wins. This
matters for a window entirely in the past: such a row sits at `Scheduled`, matches the activation
predicate, and would otherwise be activated for one pass before the next pass ended it. Re-deriving
sends it straight to `Ended` with no metafield ever written.

This is the only unscoped access to `bundle` in the codebase. It is justified by cost: a
per-shop loop would issue one D1 round-trip per installed shop every 5 minutes, almost all of
them returning nothing, scaling with installs rather than with work.

### 5.3 Step 2 — group by shop

The flat list is bucketed into one group per `shopId`. Per group, in sequence:

1. Resolve the shop via `createShopRepository(env.DB)`. Not `installed` → skip the group
   silently; the uninstall cascade will remove the rows.
2. `getShopAccessToken(domain, env)`. `null` → log the shop, skip the group, change no statuses.
   Nothing retries harder than the next pass.
3. `createRepositories(env.DB, shopId)`. **Every read and write from here on is scoped.** The
   scanner's ids are re-read through `bundles.findById`, so a scanner bug cannot reach another
   tenant's row.
4. Recompute the target with `deriveStatus(row.scheduleStart, row.scheduleEnd, now)`. If it equals
   the persisted status, the row is already correct — skip it and do no Admin work.

### 5.4 Step 3 — apply, per transport

- **`expand`** — a per-variant metafield. `writeComposition(...)` on activation,
  `clearComposition(...)` on deactivation. One Admin call per bundle, independent of the rest.
- **`merge`** — a **shop-level** metafield holding an array of every merge bundle. Calling
  `upsertMergeConfig` once per bundle would be a read-modify-write per bundle — `2N` Admin calls
  where each write clobbers the array the previous one just built. Merge transitions are
  therefore **batched per shop**: collect every merge activation and deactivation in the group,
  then perform a single read → apply all adds and removes → single write.
- **`update`** — no transport. Status moves; nothing is written to Shopify.

### 5.5 Step 4 — persist, second

The row's `status` is written **only after** the Shopify write succeeds, together with
`metafieldState` / `metafieldGid` and `scheduleError = null`.

A throw is caught **per bundle**: log it, write the message to `schedule_error`, leave `status`
untouched, continue to the next bundle. One broken bundle never stops the pass, and a bundle is
never left `Active` with nothing written at checkout.

### 5.6 Idempotency

The scan selects only rows whose persisted status disagrees with their derived status, and the
status write is the last step. A pass that dies halfway is simply re-done next pass for whatever
it did not reach; re-running an identical pass is a no-op. Both metafield writes are upserts, so
even a duplicated write is harmless.

### 5.7 Plus gating

`update`-operation bundles are refused at the route on non-Plus shops (`assertOperationAllowed`).
The cron applies the same check before activating. On refusal it leaves the bundle `Scheduled`
with the gate reason in `schedule_error` — it neither silently activates something the shop's
plan cannot run, nor silently marks it `Ended`.

### 5.8 Cost

One D1 query per pass when nothing is due, which is the common case. Work scales with due
bundles, not with installed shops.

## 6. API contract

`BundleDto` (`src/routes/bundles.ts`) and `Bundle` (`web/types/bundles.ts`) gain:

| field | type |
|---|---|
| `scheduleStart` | `string \| null` (UTC ISO) |
| `scheduleEnd` | `string \| null` (UTC ISO) |
| `scheduleError` | `string \| null` |

`POST` / `PUT` accept `scheduleStart` / `scheduleEnd` as UTC ISO strings or `null`.

`status` is no longer freely settable. The client sends `'Draft'` (off) or omits it (hand to the
schedule); the server computes the rest with `deriveStatus`. Any other value is ignored rather
than rejected, so an older client cannot pin a bundle `Active` past its end date.

### 6.1 The save path must gate on status

Today `src/routes/bundles.ts` decides whether to write a metafield purely from `operation`. Left
as-is, a merchant scheduling a bundle for next Friday would get its composition metafield written
**immediately** — live at checkout a week early, while the UI shows `Scheduled`.

Both paths therefore route through one predicate:

```ts
function shouldBeLive(row: BundleRow): boolean {
  return row.status === 'Active';   // Draft / Scheduled / Ended are never written
}
```

The save path does exactly what the cron does — write when the bundle should be live *right now*,
clear when it should not — which also means a merchant saving an already-open window does not
wait up to five minutes. **The cron only ever handles boundaries that arrive while nobody is
looking.** One predicate, one set of transport helpers, two entry points.

## 7. UI

### 7.1 Editor (`web/Pages/BundleEditor.tsx`)

A new Polaris `Card`, above the existing status control:

- Two checkboxes — "Set a start date" / "Set an end date" — since both bounds are optional.
  Unchecked → `null`.
- Each enabled bound renders `TextField type="date"` + `TextField type="time"` side by side.
  Polaris 13 has no datetime control, and a date+time pair is less fuss than a `DatePicker` in a
  `Popover` for a field a merchant fills once.
- Beneath each, the resolved value in plain words with the zone spelled out — *"Goes live Fri 3
  Oct 2026, 9:00 am (AEST)"* — from `Intl.DateTimeFormat().resolvedOptions().timeZone`. This is
  where the browser-vs-store zone limitation (§3) stops being invisible.
- A live `Badge` showing what `deriveStatus` says right now, so the merchant sees `Scheduled`
  before saving rather than after.
- `scheduleError`, when present, renders as a Polaris `Banner` with `tone="warning"`.

### 7.2 Conversion module (`web/lib/schedule.ts`)

```ts
toUtcIso(date: string, time: string): string          // '2026-10-03' + '09:00' -> '2026-10-03T09:00:00.000Z'
fromUtcIso(iso: string): { date: string; time: string }
```

`new Date('2026-10-03T09:00')` parses as local wall-clock time, so DST is the platform's problem
rather than ours. Tests pin that behaviour so a later refactor cannot quietly swap in UTC parsing.

### 7.3 List (`web/Pages/Bundles.tsx`)

A schedule column rendering the window in local time, and `StatusBadge` extended for the two
statuses it has never seen: `Scheduled → info`, `Ended → neutral` (matching the tone mapping in
the E7 spec).

## 8. Error handling

| Failure | Behaviour |
|---|---|
| Unparseable datetime on write | `400` at the route. Never stored as `null`. |
| `start >= end` | `400` at the route. |
| No offline token for a shop | Log, skip the whole group, change no statuses. Retries next pass. |
| Shop not `installed` | Skip the group silently. |
| Admin API throw on one bundle | Log, write `schedule_error`, leave `status` untouched, continue the pass. |
| Non-Plus shop, `update` bundle due | Leave `Scheduled`, gate reason into `schedule_error`. |
| Cron pass dies mid-way | Next pass re-selects whatever it did not reach. |

No fallbacks mask a missing domain, token, or GID — consistent with the root `CLAUDE.md`
fail-loudly rule.

## 9. Testing

**Unit — `deriveStatus`.** Every row of the §4.2 table, plus the boundary instants themselves
(`now === start` → `Active`; `now === end` → `Ended`), plus `Draft` never deriving.

**Unit — `web/lib/schedule.ts`.** Round-trip `toUtcIso` → `fromUtcIso`; an explicitly non-UTC
`TZ` in the test environment so a UTC-parsing regression fails; a DST-transition date.

**Repository — `DueBundleScanner`.** Against the recording fake D1 (`testing/fakeD1.ts`), assert
the emitted SQL and bindings: both predicates present, `now` bound once per branch, and — the
point of the test — that it selects id columns only.

**Lifecycle — `src/lifecycle/bundleSchedule.test.ts`**, with the in-memory repositories
(`createInMemoryRepositories`) and a fake clock:
- An `expand` bundle at its start boundary → `writeComposition` called once, status `Active`,
  `scheduleError` cleared.
- The same bundle at its end boundary → `clearComposition` called once, status `Ended`.
- Two `merge` bundles flipping in one pass for one shop → exactly **one** read-modify-write, with
  both entries reflected.
- A `Draft` bundle whose window has opened → untouched.
- A throwing Admin call → `schedule_error` written, `status` unchanged, the *next* bundle in the
  group still processed.
- A shop with no token → no status changes anywhere in that group.
- The same pass run twice → second run is a no-op.
- A bundle whose window is entirely in the past, sitting at `Scheduled` → goes to `Ended` in one
  pass, with **no** metafield write ever issued.
- Cross-tenant: a due row for shop A never reaches shop B's repositories.

**Route.** `POST`/`PUT` with a future window → status `Scheduled` and **no** metafield write.
With an already-open window → status `Active` and the metafield written. With a past window →
`Ended` and cleared. `status: 'Active'` sent by a client on a future window → ignored.

## 10. Out of scope

- Any change to the Rust cart transformer. It stays time-unaware; the metafield's presence is
  the whole signal.
- Per-bundle or store-timezone pickers (§3).
- Email or in-app notification on activation/deactivation (E9 owns that for campaigns).
- Campaign scheduling. E9 is a separate sweep that will share this cron trigger.
- Recurring or repeating windows.
