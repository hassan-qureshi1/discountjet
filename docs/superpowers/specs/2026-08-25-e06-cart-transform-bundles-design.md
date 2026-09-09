# E6 — Cart Transform extension + Bundles CRUD

**Date:** 2026-08-25
**Status:** Design — ready for `superpowers:writing-plans`
**Epic:** E6 (of 12) — see master decomposition `2026-08-25-discount-jet-decomposition.md` §7
**Shopify plan required:** **All plans (only the `update` operation is Plus)** — `expand` + `merge` run on Basic/Shopify/Advanced/Plus; `update` (`lineUpdate`) requires Shopify Plus or a development store
**App tier required:** any (Starter / Growth / Scale) — app tier caps bundle *count* (E11), never unlocks operations
**Depends on:** E1 (OAuth scopes, GraphQL Admin client, D1 schema, webhook infra)
**Blocks:** E7 (Bundle campaigns) — E7 schedules the bundles this epic defines

---

## Summary

E6 builds the **Bundles** surface: a Shopify **Cart Transform Function** (Rust) registered via
`cartTransformCreate`, plus the D1-backed CRUD and admin UI that lets a merchant define bundles
that `merge`, `expand`, or `update` cart lines at checkout. This is the app's only non-discount
on-platform mechanism; its `merge` and `expand` operations run on **all plans**, while only the
`update` operation is **Plus-gated**.

The prototype (`/discount-engine-ui`) already ships a faithful bundles list and editor, but on
hardcoded JSON and — critically — with **the wrong gating model**: it tiers `merge`/`expand`/`update`
onto the app's own pricing tiers (Starter/Growth/Scale) and treats `update` as Plus-only *on top of*
an app-tier gate. That is incorrect. Per Shopify's Cart Transform docs, **`expand` (`lineExpand`)
and `merge` (`linesMerge`) are available on every plan (Basic/Shopify/Advanced/Plus); only the
`update` (`lineUpdate`) operation requires Shopify Plus (or a dev store).** E6 removes app-tier
operation gating entirely and gates only the `update`-based feature on Plus; the app tier stays
strictly as a bundle-*count* cap (owned by E11).

There is **no cart-transform extension in the repo today** — the backend is still the unmodified
`cloudflare-shopify-starter`. E6 is greenfield: it creates `extensions/cart-transform/`, the
`bundle` D1 table, the metafield write/clear lifecycle, and the API routes the UI selector hooks
will call.

---

## Current state

**Prototype UI (design source of truth), on hardcoded fixtures:**

- `discount-engine-ui/src/pages/CartTransformation.tsx` — the **Bundles list**: summary strip
  (count / in-campaigns / avg saving), IndexTable with item thumbnails, operation badge, price,
  saving, campaign-usage count, and an Edit action. Reads `useCartTransforms()` /
  `useBundleCampaigns()` from the Zustand store.
- `discount-engine-ui/src/pages/CartTransformEditor.tsx` — the **editor**: operation selector
  (merge / expand / update), per-operation forms (merge → merged variants + price + cart-line
  override; expand → parent variant + components with qty & price adjustment; update → line
  price/title/image override), and a right rail listing real Cart Transform limits. Runs off a
  hardcoded `CATALOGUE` array. Reads `usePlan()` and `useShop()`.
- `discount-engine-ui/src/components/discount/cartTransformOps.ts` — the **gating logic being
  corrected**. Defines `OPERATIONS` with a per-operation `minTier` (Starter/Growth/Scale) and a
  `requiresPlus` flag set **only on `update`**; `gateOperation(op, appTier, shopifyPlus)` combines
  an **app-tier** check with a Plus check; `gateField()` locks "advanced" fields (title/image
  override, per-component pricing) behind the **Scale app tier**; `CART_TRANSFORM_LIMITS` and
  `MAX_EXPAND_QTY = 2000`. **This app-tier operation/field gating is the prototype error E6 fixes.**
- `discount-engine-ui/src/data/cartTransforms.json` — 4 fixture bundles (merge/expand), each with
  `operation`, `items`, `price`, `sumOfItems`, `schedule`, `status` (Active/Scheduled/Ended),
  `metafield` (Written / Not yet written / Cleared), `updated`.
- `discount-engine-ui/src/types/index.ts` — `CartTransform`, `CartTransformOp` (`merge`/`expand`/
  `update`), `CartTransformStatus`, and `Shop.shopifyPlan` (Basic/Shopify/Advanced/Plus).

**Backend:** no `extensions/` cart-transform function, no `bundle` table, no cart-transform API
routes. `/src` is still the starter template. Everything server-side in E6 is new.

---

## Shopify plan gating

**This is the central section of E6.** Everything below the API layer is downstream of getting the
gate right. This section **corrects an earlier draft of this spec** that claimed all three
operations were Plus-only end to end — that claim was wrong.

### The verbatim gate — only `update` is Plus

From Shopify's Cart Transform documentation (`cart-transform.md`, verified 2026), the Plus gate
applies to **one** operation. The docs state, globally and twice: **"Only development stores or
stores on a Shopify Plus plan can use apps with `update` operations."** There is no equivalent
sentence for `expand` or `merge`:

- `expand` (`lineExpand`, fixed bundles) — **available on all plans** (Basic / Shopify / Advanced /
  Plus). No plan-tier gate.
- `merge` (`linesMerge`, custom bundles) — **available on all plans** (Basic / Shopify / Advanced /
  Plus). No plan-tier gate.
- `update` (`lineUpdate`, line price/title/image override) — **Shopify Plus (or a development store)
  only.** This is the single Plus-gated operation.

**Do not conflate the plan gate with the selling-plan rejection rule.** The docs' other sentence —
"Shopify rejects `lineExpand`, `linesMerge`, and `lineUpdate` operations if a selling plan is
present" — lists all three operations together, but that is a **cart-contents rejection rule** (the
cart holds a subscription/selling-plan line), **not** a plan-tier gate. The earlier draft merged
these two sentences and wrongly concluded that `expand`/`merge` needed Plus. They do not. The
selling-plan guard is handled separately (see Hard platform facts and E6-7); it applies on all plans
and is orthogonal to the Plus gate.

Unlike Discount Functions (which run on all plans when distributed as a public app — master doc §2),
only the `update` cart-transform operation carries a Plus requirement; `expand`/`merge` match the
discount-function "all plans" behaviour.

### Correction vs. the prototype

Two things were wrong and both are fixed here: (1) the prototype gated **operations** on the app's
own pricing tier (Starter/Growth/Scale), and (2) an earlier draft of this spec over-corrected by
declaring **all three** operations Plus-only. The truth is in between: app tier **never** unlocks an
operation (it caps bundle *count* only, via E11), and only `update` needs Plus.

| | Prototype (`cartTransformOps.ts`) | Earlier draft (wrong) | E6 (correct) |
|---|---|---|---|
| Unlock `merge` | Starter app tier | Shopify Plus | **All plans** — no gate |
| Unlock `expand` | Growth app tier | Shopify Plus | **All plans** — no gate |
| Unlock `update` | Scale app tier **+** Plus | Shopify Plus | **Shopify Plus** (or dev store) only |
| "Advanced" fields (title/image override, per-component pricing) | Scale app tier (`gateField`) | Shopify Plus | **Not app-tier gated**; they are cart-transform features. Fields belonging to `update` follow the `update` Plus gate; `expand`/`merge` component pricing is all-plans |
| App tier (Starter/Growth/Scale) role | Unlocks operations | (unchanged) | Caps **bundle count only** (E11); never unlocks an operation |

Concretely: `OperationCard` must no longer disable an operation because the app tier is below
`minTier`, **and** must not disable `merge`/`expand` on non-Plus stores. Remove `minTier` from the
operation gate and remove `gateField`'s app-tier lock. The only per-operation Plus gate that remains
is on `update`. `expand`/`merge` and their component-pricing fields are available to **every** store
(subject to `BundlesFeature` eligibility below, and the selling-plan guard at cart time).

### Detection

There are **two independent signals**, detected server-side (never trust the client):

- **Bundle eligibility (all operations)** — the capability-oriented **`BundlesFeature`** GraphQL
  object (`shop`-level feature flag indicating bundle/cart-transform eligibility) is the
  authoritative "can this store use bundles at all" check. Some stores may be ineligible even
  without regard to plan tier. This is **not** a flat Plus gate; a Basic/Shopify/Advanced store can
  be bundle-eligible and use `expand`/`merge`.
- **`update`-operation Plus gate** — query the Admin GraphQL API for the shop plan —
  `shop.plan { partnerDevelopment shopifyPlus }` (and/or `shop.plan.displayName`). The `update`
  (`lineUpdate`) operation is offerable only when `plan.shopifyPlus === true` **or**
  `plan.partnerDevelopment === true` (dev store). `expand`/`merge` do **not** consult this signal.
- Cache both results on the `shopify_shop` row (or a small `plan_state`-adjacent field, coordinated
  with E11) and refresh on the `shop/update` webhook and on app load, so a **plan change** (upgrade
  or downgrade) is reflected without a reinstall. See Risks for downgrade handling.
- Expose them to the UI via a `GET /api/shop/plan` (or fold into the existing shop bootstrap) as
  two booleans — `bundlesEligible` (from `BundlesFeature`) and `updateOpEligible` (Plus/dev) —
  plus the raw plan name for copy.

### Upgrade-prompt UX (soft gate, never hard fail)

The Plus gate is a **soft gate** and applies **only to the `update` operation**. `merge`/`expand`
must **never** be blocked on a non-Plus store (subject only to `BundlesFeature` eligibility). A
merchant who is not on Plus can build and register live `merge`/`expand` bundles; only the `update`
operation shows an upgrade prompt.

- **List (`CartTransformation.tsx`):** do **not** blanket-gate the list on Plus. When a store is
  bundle-eligible, the list is fully usable for `merge`/`expand`. Only if the merchant tries to use
  (or filters to) an `update` bundle on a non-Plus store, show a scoped Polaris banner — "The line
  **update** operation requires Shopify Plus. Merge and expand bundles work on your current plan." —
  with a link to Shopify's plan page. If a store is **not** bundle-eligible (`BundlesFeature`),
  show the ineligibility callout instead.
- **Editor (`CartTransformEditor.tsx`):** the `merge` and `expand` operation cards render **enabled
  on every plan**. Only the `update` card is gated: on a non-Plus/non-dev store it renders with a
  single **"Requires Shopify Plus"** badge and a disabled Save-to-live action, and an `update` bundle
  can still be saved as a **draft** (status not published, metafield not written). Never a
  JavaScript-level hard failure, never a blank screen for any operation.
- **Never** surface an app-tier reason ("Upgrade to Scale") against any operation — that string is
  deleted. The only operation-level Plus reason string is **"Requires Shopify Plus,"** and it appears
  **only** on the `update` card.

### App tier stays orthogonal

The app's own tier (Starter 10 / Growth 50 / Scale 200 — master §E11) may cap **how many bundles**
a merchant can activate, exactly as it caps discounts. It does **not** decide which operations are
available. A Starter-tier Plus merchant gets all three operations; a Scale-tier Basic merchant gets
`merge` + `expand` (the `update` operation is Plus-gated). App tier unlocks **no** operation on any
plan. Count enforcement lives in E11's reconcile job, not here.

---

## Cart Transform API

**Target:** the Cart Transform Function target **`cart.transform.run`** — a single function that
receives the cart and returns a list of operations. One function, three operation kinds.

### Operations

- **`expand`** (fixed bundle → components): a parent cart line expands into its component lines at
  checkout. **Max 2000** expanded items per line (`MAX_EXPAND_QTY`). Each component may carry its
  own **price adjustment** (per-component pricing), **title**, and **image** for checkout display.
  Used for "buy the mattress set, ship the mattress + protector + sheets as line items."
- **`merge`** (custom bundle → one line): multiple cart lines merge into a **single** bundle line
  with a **`parentVariantId`** (the variant that represents the bundle) and an **overridden price**.
  The merged line can override title/image for display. Used for "buy frame + pillows, show one
  'Winter Bedroom Bundle' line at $899."
- **`update`** (line override): override an existing line's **price**, **title**, and/or **image**.
  The override is **checkout-display / pricing only** — it does not change the underlying product.
  Used for ad-hoc price/label overrides without merging or expanding.

### Registration

Register the function with **`cartTransformCreate`**:

- `functionId` / `functionHandle` — the deployed cart-transform function's handle.
- `blockOnFailure` — boolean. If `true`, a function error **blocks checkout**; if `false`, the cart
  passes through untransformed on error. See Risks for the policy decision.
- `metafields` — optional metafields set on the cart-transform object at creation.

Returns a `CartTransform` object (`gid://shopify/CartTransform/...`). Store this gid on the
`shopify_shop` row (one per store — see below).

### Hard platform facts (encode all of these)

- **One cart transform per app per store.** A store can have exactly one active cart transform from
  this app. All bundles a merchant defines are served by the **single** registered function; the
  function branches per-line using bundle config read from metafields. Registration is
  idempotent-guarded: create once, reuse the gid, do not call `cartTransformCreate` per bundle.
- **Selling-plan / subscription rejection.** Cart-transform operations are **rejected/skipped when a
  selling plan (subscription) line is present** in the cart. The function must detect selling-plan
  lines and **not** emit operations for carts containing them (guard, don't error).
- **Component data lives in variant metafields.** A bundle's component references are stored as
  **variant metafields** — namespace/key **`custom.component_reference`**, type
  **`list.variant_reference`** — on the parent/bundle variant. The function's input query reads
  these to know what to expand/merge. `requiresComponents` on the variant marks it as a bundle
  parent so **POS** and other surfaces treat it as a bundle (cannot be sold without its components).
- **2000 cap** on expand/merge quantity (`MAX_EXPAND_QTY`), surfaced in the editor's qty field.

---

## Data model

New D1 table `bundle` (the `cart_transform` row family from master §6). All conventions from
`CLAUDE.md` / master §5 apply: `crypto.randomUUID()` PKs, ISO-8601 `text()` timestamps, non-null
`shopId text` FK → `shopify_shop.id` with `onDelete: 'cascade'`.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `crypto.randomUUID()`. |
| `shopId` | text NOT NULL | FK → `shopify_shop.id`, `onDelete: 'cascade'`. |
| `name` | text NOT NULL | Merchant-facing bundle name. |
| `operation` | text NOT NULL | `'merge'` \| `'expand'` \| `'update'`. |
| `items` | text (JSON) NOT NULL | Serialized component list: `[{ variantId, qty, priceAdjustment?, titleOverride?, imageOverride? }]`. Replaces the prototype's `string[]` of names. |
| `parentVariantId` | text NULL | The bundle/parent variant (required for `merge`/`expand`; the target line for `update`). |
| `price` | integer NULL | Bundle price the shopper pays, in minor units (cents). Null for `update`-only overrides that adjust individually. |
| `sumOfItems` | integer NULL | Sum of component prices (cents), for the saving display. Derived; cached for list rendering. |
| `metafieldState` | text NOT NULL | `'NotYet'` \| `'Written'` \| `'Cleared'` — lifecycle of the variant `component_reference` metafield (maps to prototype's "Not yet written"/"Written"/"Cleared"). |
| `metafieldGid` | text NULL | The variant metafield gid once written, for later clear/update. |
| `scheduleStart` | text NULL | ISO-8601; when the bundle activates (populated by E7 bundle campaign). |
| `scheduleEnd` | text NULL | ISO-8601; when it deactivates. |
| `status` | text NOT NULL | `'Active'` \| `'Scheduled'` \| `'Ended'` \| `'Draft'` (Draft = not yet published — e.g. an `update` bundle built on a non-Plus store, or any bundle on a store that is not `BundlesFeature`-eligible). |
| `blockOnFailure` | integer (bool) NOT NULL | Per-store policy snapshot; default from store config. |
| `createdAt` | text NOT NULL | ISO-8601. |
| `updatedAt` | text NOT NULL | ISO-8601. |

**Store-level (on `shopify_shop` or adjacent):** `cartTransformGid` (the single registered
transform), `bundlesEligible` (bool, from `BundlesFeature`), `updateOpEligible` (bool, Plus/dev —
gates only the `update` operation), `shopifyPlan` (cached name). These are store singletons, not
per-bundle.

Note: the prototype's `schedule` string (`"Aug 1 → Sep 30"`) is decomposed into
`scheduleStart`/`scheduleEnd`; the UI formats the display string. `items` moves from names to
variant-id-bearing objects so the function can resolve components.

---

## Issue breakdown

### E6-1 — Rust cart-transform function + `cartTransformCreate` registration

**What.** Scaffold `extensions/cart-transform/` (Rust) targeting **`cart.transform.run`**. Input
query reads cart lines + the parent variant's `custom.component_reference`
(`list.variant_reference`) metafield and `requiresComponents`. Function returns the operations list.
Add a backend registration path that calls **`cartTransformCreate`** once per store
(`functionHandle`, `blockOnFailure`, `metafields`), stores the returned `cartTransformGid`, and is
idempotent (never registers a second transform).

**Acceptance criteria.**
- `extensions/cart-transform/` builds with the Shopify CLI and deploys as a Function.
- Input query pulls component metafields; function compiles against the 2025+ cart-transform target.
- Registration is called exactly once per store; a second call reuses the stored gid (no duplicate
  transform). Failure to register surfaces a loud error (no `?? ''` masking — CLAUDE.md).
- `blockOnFailure` value is read from store config, not hardcoded.

**Files touched.** `extensions/cart-transform/` (Rust: `src/`, `Cargo.toml`, `shopify.function.
extension.toml`, input query GraphQL); `src/routes/*` (registration route + Admin GraphQL call via
E1 client); `src/db/schema` (store `cartTransformGid`).

### E6-2 — Plan gating: gate ONLY the `update` op on Plus, soft upgrade prompt, remove app-tier operation gating

**What.** Implement the two detection signals — `BundlesFeature` (bundle eligibility, all
operations) and `shop.plan.shopifyPlus` / `partnerDevelopment` (the `update`-op Plus gate) — cache
both on the shop row, refresh on `shop/update`. Expose `bundlesEligible` + `updateOpEligible` to the
UI. **Rewrite `cartTransformOps.ts`** so that `merge`/`expand` are **never** plan-gated (available on
all plans) and **only** `update` consults the Plus signal; delete `minTier` operation gating and the
`gateField` app-tier lock, and reduce the operation-level Plus reason to "Requires Shopify Plus"
attached **only** to `update`. Add the scoped soft upgrade prompt (for `update`) to list + editor.
This gates only the `update`-based feature — not `merge`/`expand`.

**Acceptance criteria.**
- `merge` and `expand` are enabled and live-registerable on **any** bundle-eligible store, including
  Basic/Shopify/Advanced — they must **not** be blocked on non-Plus.
- `update` is enabled on a Plus (or dev) store, and on a non-Plus store shows a single "Requires
  Shopify Plus" badge with a disabled Save-to-live and a draft-save path; **no** hard failure and
  **no** "Upgrade to {tier}" string appears anywhere on any operation.
- A store that is not `BundlesFeature`-eligible sees the ineligibility callout; plan tier alone never
  blocks `merge`/`expand`.
- App tier never enables/disables an operation (verified with a Starter-tier Plus store → all ops on;
  a Scale-tier Basic store → `merge`/`expand` on, `update` Plus-gated).
- Both signals are detected server-side; the client booleans are advisory only (the register route
  re-checks, and rejects a live `update` registration on a non-Plus store).

**Files touched.** `discount-engine-ui/src/components/discount/cartTransformOps.ts` (gate rewrite);
`discount-engine-ui/src/pages/CartTransformation.tsx` + `CartTransformEditor.tsx` (banners, badge
copy, remove `appTier`/`gateField` usage); `src/routes/*` (`GET /api/shop/plan` or bootstrap field);
`src/db/schema` (cached plan fields); `shop/update` webhook handler.

### E6-3 — `merge` operation (custom bundles) + variant `component_reference` metafields

**What.** Implement the `merge` branch in the function: collapse the configured cart lines into one
line with `parentVariantId` and overridden `price` (+ optional title/image). On bundle save, write
the parent variant's `custom.component_reference` (`list.variant_reference`) metafield listing the
merged variants, set `requiresComponents`, and record `metafieldState = 'Written'` + `metafieldGid`.

**Acceptance criteria.**
- Configured cart lines merge into a single bundle line at the overridden price in a function-runner
  fixture.
- `merge` is usable and live-registerable on **all plans** (Basic/Shopify/Advanced/Plus) — it must
  **not** be blocked or badged "Requires Shopify Plus" on a non-Plus store.
- Saving a merge bundle writes the variant metafield and flips `metafieldState` to `Written`.
- Deleting/deactivating clears the metafield → `Cleared`.

**Files touched.** `extensions/cart-transform/src/` (merge logic + input query); `src/routes/*`
(metafield write/clear via Admin GraphQL); `discount-engine-ui/src/pages/CartTransformEditor.tsx`
(merge form wired to real variants).

### E6-4 — `expand` operation (fixed bundles, 2000 cap, per-component price/title/image)

**What.** Implement the `expand` branch: a parent line expands into component lines, each with
optional price adjustment, title, and image. Enforce the **2000** per-line cap. Read components from
the parent variant's `component_reference` metafield.

**Acceptance criteria.**
- A parent line expands into its components with correct quantities and per-component price
  adjustments in a fixture.
- `expand` (and its per-component price/title/image fields) is usable and live-registerable on
  **all plans** (Basic/Shopify/Advanced/Plus) — it must **not** be blocked or badged "Requires
  Shopify Plus" on a non-Plus store, and the advanced fields are ungated from the app tier.
- Total expanded quantity > 2000 is rejected/clamped with a clear validation message in the editor
  and a function-side guard.
- Component title/image overrides render at checkout (display-only).

**Files touched.** `extensions/cart-transform/src/` (expand logic); `discount-engine-ui/src/pages/
CartTransformEditor.tsx` (components form, `MAX_EXPAND_QTY` validation, advanced fields ungated from
app tier); `src/routes/*` (persist component config).

### E6-5 — `update` operation (line price / title / image override) — the ONLY Plus-gated operation

**What.** Implement the `update` (`lineUpdate`) branch: override a target line's price, title, and/or
image (checkout-display/pricing only). No merge, no expand. **This is the single Plus-gated
operation** — per the Shopify docs, only development stores or stores on a Shopify Plus plan can use
apps with `update` operations. It is gated on the `updateOpEligible` signal from E6-2.

**Acceptance criteria.**
- A targeted line's price/title/image is overridden in a fixture; underlying product is unchanged.
- On a **Plus (or dev) store**, `update` is fully available with no app-tier gate (corrects the
  prototype where it was Scale-only).
- On a **non-Plus store** (`updateOpEligible === false`), the `update` card shows a single "Requires
  Shopify Plus" badge and a disabled Save-to-live, and an `update` bundle can still be saved as a
  `Draft`; the register route refuses to live-register an `update` transform on such a store.
- The Plus gate applies **only** to `update` — `merge`/`expand` remain available (see E6-3/E6-4).

**Files touched.** `extensions/cart-transform/src/` (update logic); `discount-engine-ui/src/pages/
CartTransformEditor.tsx` (update form); `src/routes/*`.

### E6-6 — Bundles list + editor CRUD (replace fixtures with API)

**What.** Back the prototype list/editor with real data: `bundle` table CRUD API, replace the
`CATALOGUE` array and `cartTransforms.json` with a Shopify **ResourcePicker** for variants and live
API reads behind the existing `useCartTransforms` / `useCartTransform` selector hooks. Persist
create/edit/delete; compute `sumOfItems` from real variant prices.

**Acceptance criteria.**
- List renders from `GET /api/bundles`; summary strip (count / in-campaigns / avg saving) computed
  server- or store-side from real rows.
- Create/edit/delete persist to D1 and reflect in the list without a reload.
- Variant selection uses ResourcePicker, not the hardcoded catalogue.
- Selector-hook signatures unchanged (drop-in per master §5).

**Files touched.** `src/routes/*` (`GET/POST/PUT/DELETE /api/bundles`); `src/db/schema` (`bundle`
table + Drizzle migration); `discount-engine-ui/src/pages/CartTransformation.tsx` +
`CartTransformEditor.tsx` (API-backed, ResourcePicker); `discount-engine-ui/src/store/
useDiscountStore.ts` (hooks call API).

### E6-7 — Selling-plan/subscription guard, `blockOnFailure` policy, one-transform-per-store handling

**What.** Function-side guard that skips operations when a **selling-plan/subscription** line is in
the cart. Define and persist the store's **`blockOnFailure`** policy (default chosen in Risks) and
plumb it into `cartTransformCreate`. Handle the **one-transform-per-store** constraint: detect an
existing transform (this app's or a conflicting one), reuse/adopt ours, and surface a clear message
if another app already owns the store's single transform.

**Acceptance criteria.**
- Cart with a subscription line → function emits **no** operations (no error, checkout proceeds).
- `blockOnFailure` is configurable and applied at registration; its value is auditable.
- Registering when a transform already exists does not create a duplicate; a foreign-owned transform
  produces a clear, non-fatal merchant message.

**Files touched.** `extensions/cart-transform/src/` (selling-plan guard); `src/routes/*`
(registration conflict handling, policy persistence); `discount-engine-ui/src/pages/
CartTransformation.tsx` (conflict/eligibility messaging).

---

## Testing

- **Function-runner fixtures, one per operation:**
  - `merge` — multi-line cart → single bundle line at overridden price; assert line count and price.
  - `expand` — parent line → N component lines with per-component adjustments; assert quantities.
  - `update` — target line price/title/image overridden; underlying variant untouched.
- **2000 cap** — expand fixture requesting > 2000 total → rejected/clamped; editor blocks input over
  `MAX_EXPAND_QTY`.
- **Selling-plan guard** — cart containing a selling-plan line → **zero** operations emitted,
  checkout unaffected (assert pass-through).
- **Plan-gate behavior** (only `update` is Plus-gated) —
  - Plus store: all three operations enabled, advanced fields enabled, register succeeds.
  - Dev store: same as Plus (dev unlocks the `update` operation for testing).
  - Basic/Shopify/Advanced (bundle-eligible): `merge` + `expand` enabled and **live-registerable**
    (must **not** be blocked or badged); `update` badged "Requires Shopify Plus" with draft-save
    allowed and **no** live `update` registration; **no** "Upgrade to {tier}" string anywhere.
  - Not `BundlesFeature`-eligible: ineligibility callout shown; no operation live-registers.
  - App-tier orthogonality: Starter+Plus → all ops on; Scale+Basic → `merge`/`expand` on, `update`
    Plus-gated; app tier gates **no** operation on any plan.
- **One-transform-per-store** — second registration reuses the stored gid (no duplicate); foreign
  transform → non-fatal conflict message.
- **Metafield lifecycle** — save → `Written` + gid recorded; delete/deactivate → `Cleared`.

---

## Risks / open questions

- **One-transform-per-store coexistence.** A store can host only one cart transform, and it may
  already belong to another installed app. Decision needed: do we adopt/overwrite (destructive to
  the other app), refuse and message the merchant, or detect-and-coexist (impossible — it's a hard
  singleton)? Proposed: **refuse + clear message**, never clobber a foreign transform.
- **`blockOnFailure` policy.** `true` protects pricing integrity (a broken bundle blocks checkout
  rather than selling at the wrong price) but risks blocking *all* checkouts on a function bug.
  `false` favors availability but can sell un-transformed bundles at full component price. Proposed
  default: **`false`** (never block checkout), with per-store opt-in to `true`, revisited after
  production telemetry. Open.
- **Plan downgrade handling — scoped to `update` only.** A Plus merchant with active bundles
  downgrades to Advanced. Because only the `update` operation is Plus-gated, `merge`/`expand` bundles
  **keep working** and must **not** be parked; only `update` bundles lose eligibility. (The earlier
  premise that a downgrade kills all bundles is void — non-Plus merchants can still run
  `merge`/`expand`.) On `shop/update` detecting loss of `updateOpEligible`, reconcile **only**
  `update` bundles. Open: for those, do we (a) auto-clear their metafields and set them to a
  `Draft`/parked state with a re-activate-on-upgrade path, or (b) leave them and rely on Shopify to
  no-op the `update` op? Proposed: **(a)** for `update` bundles only — park them, clear their
  metafields, preserve config so they reactivate on re-upgrade (mirrors E9's clear pass); leave
  `merge`/`expand` untouched. Coordinate with E11 reconcile.
- **`BundlesFeature` availability.** If the `BundlesFeature` object is unavailable on some API
  versions, fall back to `shop.plan.shopifyPlus` / `partnerDevelopment`. Confirm the field's presence
  on the pinned Admin API version during E6-2.
- **Component-price source of truth.** `sumOfItems` derives from live variant prices, which drift.
  Decide whether to snapshot at save time (stable saving display) or recompute on read (accurate but
  variable). Proposed: recompute on read for the list, snapshot at campaign-schedule time (E7).
