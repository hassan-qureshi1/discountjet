# E3 — Per-function admin UI extensions (authoring)

**Date:** 2026-08-25
**Status:** Design — ready for `superpowers:writing-plans`
**Epic:** E3 · **Shopify plan:** All (public-app distribution — no Plus gate)
**Depends on:** E2 (three independent Rust discount functions — `discount-tier` / `discount-bundle` / `discount-special` — each with its own `handle`/`uid` and `$app:discount-<type>.config` metafield contract)
**Blocks:** E5 (create-from-template writes the same per-function metafield contract), E8 (campaign publish orchestration writes the same contract via `discountAutomaticAppCreate`) — both depend on E3 fixing the **shared metafield contract** (definition + key + JSON shape) per type.
**Parent spec:** `2026-08-25-discount-jet-decomposition.md` (§1a decisions, §4 API facts, §7 E3, §5 conventions)

---

## Summary

E3 splits the monolithic Preact `discount-ui` admin extension (which renders all three discount
modes behind a `rule_type` select) into **three independent admin UI extensions**, one per E2
function:

| UI extension | Renders | Links to E2 function | Writes metafield key |
|---|---|---|---|
| `discount-tier-ui` | `TierCard`s only | `discount-tier` | `$app:discount-tier.config` |
| `discount-bundle-ui` | `BundleDiscountCard`s only | `discount-bundle` | `$app:discount-bundle.config` |
| `discount-special-ui` | `SpecialDiscountCard`s only | `discount-special` | `$app:discount-special.config` |

Each extension targets `admin.discount-details.function-settings.render` (api_version `2025-10`),
is linked from its function's `[extensions.ui] handle`, ensures **its own** metafield *definition*
exists, and writes **its own** key via `shopify.applyMetafieldChange`. The `rule_type`/`ruleType`
mode select is **removed** — the extension *is* the type, so there is no cross-mode data-loss path.

The authoring model is **native-page authoring**: a merchant creates a discount on Shopify's
**native discount page**, picks the app function (Tier / Bundle / Special), and the matching admin
UI extension renders inline in the function-settings block and writes the config metafield on
**Save**. There is **no embedded-app wizard** and **no `discountAutomaticAppCreate`** for manual
authoring — the app runs no create mutation on this path. (Programmatic creation for templates (E5)
and campaigns (E8) *does* call `discountAutomaticAppCreate`/`discountCodeAppCreate`, writing the
**same** per-function metafield contract — out of scope here.)

E3 ports the port-source's proven pieces — the metafield definition ensure/create, the
`applyMetafieldChange` write, the 10 KB size meter, the validation banner, and the
`useResourceDetails` "persist IDs only, hydrate titles/SKUs/images live" pattern — into a **shared
component library** consumed by all three UIs, so the three per-type cards are the only divergence.

---

## Current state

### Port source — the monolithic Preact `discount-ui` (`eva/discount-engine`)

One `ui_extension` (`extensions/discount-ui/shopify.extension.toml`, api_version `2025-10`, single
target `admin.discount-details.function-settings.render`, module `./src/DiscountFunctionSettings.jsx`)
renders **all three modes**:

- `src/DiscountFunctionSettings.jsx` — mounts `<App/>` with Preact `render`, and on load calls
  `getMetafieldDefinition()` → `createMetafieldDefinition()` (ensure-or-create the definition before
  rendering; throws if creation fails).
- `src/components/App.jsx` — holds a **`rule_type` select** (`<s-select label="Discount Mode">`
  with options `tier-discount` / `bundle-discount` / `special_discount`) and conditionally renders
  `TierCard` / `BundleDiscountCard` / `SpecialDiscountCard` per selected mode. Switching modes runs
  `switchRuleTypeAndClearOther` and shows a **data-loss banner** ("All existing configuration for
  the previous mode will be lost once you save.") — a hazard that exists *only because* one
  extension multiplexes three types.
- `src/utils/metafield.js` — **single** namespace/key: `METAFIELD_NAMESPACE = "$app:discount-engine"`,
  `METAFIELD_KEY = "config"`. `getMetafieldDefinition()` (query `metafieldDefinitions` on ownerType
  `DISCOUNT`), `createMetafieldDefinition()` (`metafieldDefinitionCreate`, ownerType `DISCOUNT`,
  `type: json`, `access.admin: MERCHANT_READ_WRITE`, name "Discount Configuration"), and
  `parseMetafield()` (JSON → form state; handles legacy single-object + new-array shapes for all
  three modes, plus `rule_type` dispatch).
- `src/hooks/useExtensionData.js` — the form-state engine: parse → `formData`, per-type add/update/
  remove for tiers/bundles/specials, `switchRuleTypeAndClearOther`, the three validators
  (`validateTierConfig` / `validateBundleConfig` / `validateSpecialConfig`), `buildConfigFromFormData`
  (emits the metafield JSON, **stripping display-only fields** via `slimSelectionItems` — persists
  IDs only), `getMetafieldSizeBytes` (`TextEncoder` byte length), `METAFIELD_MAX_SIZE_BYTES = 10*1024`,
  `validateMetafieldSize` (throws >10 KB), and `applyExtensionMetafieldChange` (validate + size-guard
  + `applyMetafieldChange({ type:"updateMetafield", namespace, key, value, valueType:"json" })`).
- `src/hooks/useResourceDetails.js` — since the metafield persists **IDs only**, this hook re-fetches
  `title` / `variantTitle` / `sku` / `image` from the Admin API (`nodes(ids:)` GraphQL over
  `gid://shopify/Product|ProductVariant/…`), caches per numeric id, and only fetches ids not already
  carrying an image (freshly picked items already have it from the resource picker).
- `src/components/{TierCard,BundleDiscountCard,SpecialDiscountCard}.jsx` — the per-type config cards,
  each driving `shopify.resourcePicker` (variant vs whole-product selection) and rendering selection
  via `SelectedResources.jsx` (wrapping chips: thumbnail + name + SKU + remove ✕, hydrated by
  `useResourceDetails`). `ConfigurationPreview.jsx` renders a live tier-mode recap banner.

### Prototype embedded wizard — superseded for manual authoring

The `discount-engine-ui` React/Polaris prototype ships an **embedded** `DiscountSetup` wizard
(`pages/DiscountSetup.tsx` + `components/discount/DiscountSetupForm.tsx` +
`DiscountFunctionSettings.tsx` + `discountForm.ts`) that re-implements the same three-mode authoring
inside the app, backed by Zustand fixtures and a `SAMPLE_VARIANTS`/`SAMPLE_PRODUCTS` stand-in for
the resource picker. **This embedded wizard is superseded for manual authoring** by the per-function
admin UI extensions in this epic and by native-page authoring (§1a decision 4). The embedded app
does **not** deep-render the authoring form; instead it **deep-links merchants to Shopify's native
create-discount flow**. The embedded app retains its non-authoring surfaces — discounts list/detail
(E4), promotion templates (E5), campaigns (E8), bundles (E6) — none of which host the discount
config form anymore.

### Backend (greenfield)

Manual authoring requires **no** Worker route: the admin UI extension talks to Shopify directly via
the `shopify` global (`shopify.query`, `shopify.resourcePicker`, `shopify.applyMetafieldChange`).
The GraphQL Admin client (E1-3) is needed for *programmatic* creation (E5/E8) and sync (E4), not for
this epic. E3 adds **no** `/api/*` route unless a supporting Admin query is proven necessary (see
§ Issue breakdown E3-6).

---

## Shopify plan gating

**No gate — all plans.** Per master §2–§3, distributing Discount Jet as a **public app** lets the
Discount Functions (Tier / Bundle / Special) and their admin UI extensions run on **Basic, Shopify,
Advanced, and Plus**. Manual authoring uses only the native discount page + admin UI extension +
`applyMetafieldChange` — all available on every plan for public apps. **No Plus gate anywhere in E3;
the UI must never render a plan-upgrade prompt.**

Contrast (out of scope): the Plus-only surface is E6/E7 (Cart Transform bundles). The **25 active
discount functions** ceiling (master §4) is a Shopify *platform* limit, not a plan gate — it is not
enforced in E3 (there is no create mutation here); it surfaces on the programmatic path (E5/E8) and
in reconcile (E11).

---

## Target architecture

### Three admin UI extensions (one per function)

Each function's directory carries its own admin UI extension. Directory layout under
`discount-jet/extensions/` (functions from E2; UIs from this epic):

```
extensions/
  discount-tier/            (E2 — Rust function)
    shopify.extension.toml  → [extensions.ui] handle = "discount-tier-ui"
  discount-tier-ui/         (E3 — admin UI extension)
    shopify.extension.toml  → target admin.discount-details.function-settings.render
    src/DiscountTierSettings.jsx
  discount-bundle/          (E2)  → [extensions.ui] handle = "discount-bundle-ui"
  discount-bundle-ui/       (E3)  → src/DiscountBundleSettings.jsx
  discount-special/         (E2)  → [extensions.ui] handle = "discount-special-ui"
  discount-special-ui/      (E3)  → src/DiscountSpecialSettings.jsx
  shared/ (or a workspace package @discount-jet/discount-ui-shared)
    metafield.js            (per-type namespace/key, parameterized)
    useExtensionData.js     (single-type; no rule_type)
    useResourceDetails.js   (verbatim port)
    components/{SelectedResources,ConfigurationPreview}.jsx
    components/{TierCard,BundleDiscountCard,SpecialDiscountCard}.jsx
```

Each admin UI `shopify.extension.toml` (ported from `discount-ui`'s TOML) declares:
- `api_version = "2025-10"`
- `type = "ui_extension"`, a **distinct** `handle`/`uid`/`name` per type
- a single `[[extensions.targeting]]` with `module = "./src/Discount<Type>Settings.jsx"` and
  `target = "admin.discount-details.function-settings.render"`

**Linkage to E2:** each E2 discount function's `shopify.extension.toml` links its UI via
`[extensions.ui] handle = "discount-<type>-ui"`, so that when a merchant selects that function on the
native discount page, Shopify renders the matching admin UI extension in the function-settings block.

### Native-page authoring flow

```
Merchant → Shopify Admin → Discounts → Create discount → "App" → picks Discount Jet · <Tier|Bundle|Special>
        → native discount page renders, with the linked admin UI extension inline in
          admin.discount-details.function-settings.render
        → extension ensures its metafield DEFINITION exists (create-if-missing)
        → merchant configures cards, picks products/variants via shopify.resourcePicker
        → Save (native page's save) → onSubmit → applyMetafieldChange writes $app:discount-<type>.config
        → Shopify persists the discount + metafield; app runs NO create mutation
        ── later ── discounts/create webhook → E4 mirrors into D1 (discount + discount_config)
```

The embedded Discount Jet app **routes merchants to this native flow** (deep-link to the native
create-discount page pre-scoped to the app function) rather than hosting the form itself.

### Per-function metafield definition + key

Un-share the monolith's single `$app:discount-engine` / `config` into **three** definitions, one per
UI, each ensured on mount:

| UI | namespace | key | ownerType | type | access |
|---|---|---|---|---|---|
| `discount-tier-ui` | `$app:discount-tier` | `config` | `DISCOUNT` | `json` | `MERCHANT_READ_WRITE` |
| `discount-bundle-ui` | `$app:discount-bundle` | `config` | `DISCOUNT` | `json` | `MERCHANT_READ_WRITE` |
| `discount-special-ui` | `$app:discount-special` | `config` | `DISCOUNT` | `json` | `MERCHANT_READ_WRITE` |

(Master §4 writes these as full keys `$app:discount-tier.config` etc. — i.e. namespace
`$app:discount-tier`, key `config`.) Each function (E2) reads **only** its own key; the JSON shape
per key stays exactly as the monolith emitted it for that mode (`buildConfigFromFormData`), minus the
now-implicit `rule_type` field — the function no longer needs `rule_type` to dispatch, though it MAY
be retained for the E4 `discount_config` mirror's `rule_type` column; decide with E2/E4 (see Risks).

### Framework & shared-library decision

**Keep Preact.** The port source is Preact and the entire component/hook tree (`preact/hooks`,
`s-*` polaris-web-component tags) works as-is against the admin UI extension runtime; a React rewrite
buys nothing here and risks behavioral drift in the ported validators/serializer. (The *embedded app*
remains React 18 + Polaris per master §5 — that is a different surface. The admin UI extensions do
**not** share React with the embedded app; they are separate builds.)

**Shared component library.** Extract the common tree into a `shared/` package (workspace package or
path import) consumed by all three UIs so per-type divergence is only the card + which single key it
writes:
- `useResourceDetails.js` — ported verbatim (ID-only persistence → live hydration).
- `SelectedResources.jsx`, `ConfigurationPreview.jsx` — ported; `ConfigurationPreview` generalized or
  kept tier-specific (it is tier-only today).
- `TierCard.jsx`, `BundleDiscountCard.jsx`, `SpecialDiscountCard.jsx` — ported; each imported by
  exactly one UI.
- `metafield.js` — parameterized by `(namespace, key)` so each UI passes its own pair; drop the
  `rule_type` dispatch in `parseMetafield` (each parser handles one shape).
- `useExtensionData.js` — **single-type** variant: remove `ruleType`, `switchRuleTypeAndClearOther`,
  and the cross-mode clear logic; keep the validator, `buildConfigFromFormData` (for its type), size
  meter, and `applyExtensionMetafieldChange` (parameterized namespace/key).
- The **10 KB meter**, **validation banner**, and **size guard** — ported once, shared by all three.

### Superseded embedded wizard (restated)

The prototype's embedded `DiscountSetup` wizard is **not** carried forward as an authoring surface.
Manual authoring lives entirely in the native page + admin UI extension. The embedded app keeps
lists/detail (E4), templates (E5), campaigns (E8), and bundles (E6), and deep-links to the native
create-discount flow for authoring.

---

## Config write path

All ported from `metafield.js` / `useExtensionData.js` / `useResourceDetails.js`, now single-type
and per-key.

### 1. Metafield definition ensure/create (on mount)

Each UI's entry module (`Discount<Type>Settings.jsx`) runs before render:

```
existing = getMetafieldDefinition(namespace, key)   // query metafieldDefinitions(ownerType: DISCOUNT, namespace, key)
if (!existing) {
  created = createMetafieldDefinition(namespace, key)  // metafieldDefinitionCreate
  //   definition: { ownerType: DISCOUNT, type: "json", access: { admin: MERCHANT_READ_WRITE },
  //                 namespace: "$app:discount-<type>", key: "config", name: "…" }
  if (!created) throw new Error("Failed to create metafield definition")
}
render(<App/>, document.body)
```

Namespace/key differ per UI; everything else is the shared helper. Fail loudly on create failure
(no silent fallback — master §5).

### 2. Write via `applyMetafieldChange`

On the native page's **Save** (`<s-function-settings onSubmit={…}>`), the shared
`applyExtensionMetafieldChange`:
1. Runs the type's validator; throws (blocks save) if errors.
2. Builds the minimized value via `buildConfigFromFormData` (**IDs only** — display fields stripped
   by `slimSelectionItems`).
3. `validateMetafieldSize(value)` — throws if > 10 KB.
4. `applyMetafieldChange({ type: "updateMetafield", namespace: "$app:discount-<type>", key: "config",
   value, valueType: "json" })`.

### 3. 10 KB size meter (warn 80% / block 100%)

`METAFIELD_MAX_SIZE_BYTES = 10 * 1024`. `getMetafieldSizeBytes(formData)` = `TextEncoder` byte length
of the **serialized minimized value** (not the raw form). The size banner (ported from `App.jsx`)
recomputes on every form change:
- `bytes > 8 192 B` (80 %) → **warning** banner ("Maximum 10 KB per discount configuration. Save will
  fail if exceeded." + live "Metafield size: X.XX KB / 10 KB").
- `bytes > 10 240 B` (100 %) → **critical** banner + **Save blocked** (the size guard throws in
  `applyExtensionMetafieldChange`, and the banner shows "(exceeds limit)").

### 4. Validation banner

The type's validator (`validateTierConfig` / `validateBundleConfig` / `validateSpecialConfig`, ported
verbatim) feeds a critical banner ("Please fix the following errors:") and blocks Save. Rules retained:
- **Tier:** each tier needs a non-empty `value`, ≥1 selected product/variant; `discountType` + `platform` required.
- **Bundle:** each bundle needs ≥1 source, ≥1 target, an `operator`, a `value`, a non-empty `message`;
  `platform` required; `max_target_qty` validated only when `fixed_ratios`.
- **Special:** each config needs ≥1 source, ≥1 target with ≥1 item each, a non-empty `message`; `platform` required.

The Bundle UI keeps the "same targeted product can't be in two bundles in one discount instance"
warning banner (ported from `App.jsx`).

### 5. Live resource hydration (persist IDs only)

`useResourceDetails(items, selectorType)` — ported verbatim. The metafield stores **IDs only**; on
load the UI re-fetches `title` / `variantTitle` / `sku` / `image` from the Admin API
(`nodes(ids:)` over `gid://shopify/Product|ProductVariant/<id>`), caches per numeric id, and skips
ids that already carry an image (freshly picked items). `SelectedResources.jsx` renders the hydrated
chips; deleted/renamed products degrade to the id as fallback (see Risks). `shopify.resourcePicker`
drives selection (variant vs whole-product) and is pre-seeded with the current selection so
re-opening preserves chosen items.

---

## Issue breakdown

### E3-1 — Admin UI scaffolding + shared library + per-function metafield definitions

**What:** Stand up the three admin UI extension directories (`discount-tier-ui`, `discount-bundle-ui`,
`discount-special-ui`), each with a `shopify.extension.toml` (api_version `2025-10`, distinct
`handle`/`uid`/`name`, single target `admin.discount-details.function-settings.render`) and an entry
module. Extract the shared library (`useResourceDetails`, `SelectedResources`, `ConfigurationPreview`,
parameterized `metafield.js` + single-type `useExtensionData.js`, the 10 KB meter, validation banner,
size guard). Implement per-function definition ensure/create with the correct namespace/key per UI.

**Acceptance criteria:**
- Three extensions build and each renders only in its own function-settings block.
- Each entry module ensures **its** definition (`metafieldDefinitionCreate`, ownerType `DISCOUNT`,
  `type: json`, access `MERCHANT_READ_WRITE`, namespace `$app:discount-<type>`, key `config`) and
  throws loudly on create failure.
- Shared library is imported by all three; no per-type copy of `useResourceDetails`/`SelectedResources`.
- No `rule_type`/"Discount Mode" select and no cross-mode data-loss banner appear in any UI.

**Files touched:** `extensions/discount-tier-ui/shopify.extension.toml`,
`extensions/discount-bundle-ui/shopify.extension.toml`,
`extensions/discount-special-ui/shopify.extension.toml`,
`extensions/discount-tier-ui/src/DiscountTierSettings.jsx`,
`extensions/discount-bundle-ui/src/DiscountBundleSettings.jsx`,
`extensions/discount-special-ui/src/DiscountSpecialSettings.jsx`,
`extensions/shared/{metafield.js,hooks/useExtensionData.js,hooks/useResourceDetails.js,components/SelectedResources.jsx,components/ConfigurationPreview.jsx}`.

### E3-2 — Tier admin UI extension

**What:** Wire `discount-tier-ui` to render the tier config only: discount type (%/amount), apply-to
(price/compare-at), platform (BOTH/POS/CHECKOUT), checkout message, selection strategy
(ALL/FIRST/MAXIMUM), and N `TierCard`s (value, min_qty, selectorType, product/variant selection) with
add/remove and `ConfigurationPreview`.

**Acceptance criteria:**
- Add/remove tiers; ≥1 tier enforced; per-tier validation matches ported `validateTierConfig`.
- Selector-type toggle clears that tier's selection (`onUpdate('targets','[]')`).
- Save writes `$app:discount-tier.config`; JSON shape matches the E2 `discount-tier` serde contract.

**Files touched:** `extensions/discount-tier-ui/src/DiscountTierSettings.jsx`,
`extensions/shared/components/TierCard.jsx`, `extensions/shared/components/ConfigurationPreview.jsx`.

### E3-3 — Bundle admin UI extension

**What:** Wire `discount-bundle-ui` to render `BundleDiscountCard`s only: source/target selectors,
operator/value/apply-to/message, and the quantity-dependent rules (`quantity_dependent`,
`target_per_source`, `fixed_ratios`, `shared_pool`, `max_target_qty`, `min_qty`, per-bundle selection
strategy). Retain the "same targeted product can't be in two bundles in one discount" warning banner.

**Acceptance criteria:**
- Add/remove bundles; ≥1 source, ≥1 target, and a message enforced per bundle
  (ported `validateBundleConfig`).
- Quantity-dependent controls toggle correctly; `max_target_qty` disabled unless `fixed_ratios`.
- Save writes `$app:discount-bundle.config` matching the E2 `discount-bundle` serde contract.

**Files touched:** `extensions/discount-bundle-ui/src/DiscountBundleSettings.jsx`,
`extensions/shared/components/BundleDiscountCard.jsx`.

### E3-4 — Special/Split admin UI extension

**What:** Wire `discount-special-ui` to render `SpecialDiscountCard`s only: a source (qualifying)
discount (operator/value/message + source selector) + N discounted-set targets, each with its own
operator/value/message + target selector; quantity-dependent rules; add/remove targets and configs.

**Acceptance criteria:**
- Add/remove configs and per-config targets; ≥1 source, ≥1 non-empty target set, and a message
  enforced (ported `validateSpecialConfig`).
- Save writes `$app:discount-special.config` matching the E2 `discount-special` serde contract.

**Files touched:** `extensions/discount-special-ui/src/DiscountSpecialSettings.jsx`,
`extensions/shared/components/SpecialDiscountCard.jsx`.

### E3-5 — Metafield write path + 10 KB enforcement + validation banner (mode select removed)

**What:** Finalize the shared write path: single-type `applyExtensionMetafieldChange` (validate →
build minimized value → 10 KB size guard → `applyMetafieldChange` with the UI's namespace/key); the
size meter measuring **serialized** bytes with 80 %/100 % banners; the validation banner blocking
Save. Delete the `rule_type`/`ruleType` field, the mode `<s-select>`, and `switchRuleTypeAndClearOther`
from the shared `useExtensionData` (each UI is single-type).

**Acceptance criteria:**
- Save blocked while `validationErrors.length > 0` OR `bytes > 10 240`; warning banner at > 8 192 B.
- The value written contains **IDs only** (display fields stripped by `slimSelectionItems`).
- No `ruleType` remains in shared state; no data-loss banner exists.
- Each UI writes exactly one key (`$app:discount-<type>.config`) via `applyMetafieldChange`
  (`type:"updateMetafield"`, `valueType:"json"`).

**Files touched:** `extensions/shared/hooks/useExtensionData.js`,
`extensions/shared/metafield.js`, and the three `Discount<Type>Settings.jsx` entry modules.

### E3-6 — Live resource hydration + resource picker

**What:** Port `useResourceDetails` (persist IDs only → re-fetch title/variantTitle/sku/image via
Admin `nodes(ids:)`), `SelectedResources` chips, and the `shopify.resourcePicker` selection paths
(variant vs whole-product, pre-seeded with current selection) into the shared library. Confirm the
extension's `read_products` scope (E1) covers the hydration query; if a supporting Admin query must
run server-side instead of via the `shopify` global, add a single justified App Proxy/API route.

**Acceptance criteria:**
- Opening a saved discount hydrates every chip (title/SKU/image) from stored IDs; re-opening the
  picker preserves the current selection.
- Deleted/renamed products degrade to an id fallback without failing the whole render.
- Only ids lacking an image trigger a fetch; per-id cache prevents re-fetch on add/remove.
- If any server route is added, it is under `requireShop` with a `PUBLIC_API_PATHS` justification
  entry (master §5) — default is **no** new route (direct `shopify.query`).

**Files touched:** `extensions/shared/hooks/useResourceDetails.js`,
`extensions/shared/components/SelectedResources.jsx`, the three per-type cards' picker handlers
(shared), and — only if proven necessary — `src/routes/*` + `src/index.ts`.

### E3-7 — Framework decision + shared component library consolidation

**What:** Record and enforce the **keep-Preact** decision and consolidate the shared library so the
three UIs diverge only by card + key. Document the build setup (per-extension `shopify.extension.toml`
+ shared path/package import), remove any per-UI duplication, and add a lint/CI check that the shared
tree is imported (not copied) by all three.

**Acceptance criteria:**
- One shared source of truth for `useResourceDetails`, `SelectedResources`, `ConfigurationPreview`,
  `metafield.js`, `useExtensionData.js`, and the 10 KB meter/validation/size-guard.
- Each UI's own code is limited to its entry module + its one card import + its namespace/key.
- Framework decision (Preact retained; React rewrite rejected) is written into the epic doc with
  rationale; embedded-app React is noted as a separate, non-shared build.

**Files touched:** `extensions/shared/**`, the three `extensions/discount-<type>-ui/**` dirs,
and a short decision note appended here / in the plan.

---

## Testing

- **Admin UI extension dev/testing** — run each extension via the Shopify CLI dev flow against a dev
  store; open a native discount using each app function and confirm the correct UI renders in
  `admin.discount-details.function-settings.render` and **only** its type's config appears (no mode
  select).
- **Metafield definition ensure/create** — first render on a store with no definition creates it
  (correct namespace/key/ownerType/type/access); second render finds the existing one and does not
  duplicate; create failure throws loudly.
- **Metafield round-trip** — save a config, reload the discount, and assert the parser rehydrates
  identical form state (IDs only in storage; titles/SKUs/images re-fetched via `useResourceDetails`).
  Assert each UI writes only its own key and never the other two.
- **10 KB enforcement** — boundary tests at 80 % (8 192 B → warning, save allowed) and 100 %
  (10 240 B → critical banner + save blocked / `validateMetafieldSize` throws); assert bytes are
  measured on the **serialized minimized** value.
- **Validation** — each ported validator rule (empty tier value / no products / missing bundle or
  special message / empty target set / missing platform) surfaces in the banner and blocks Save.
- **Contract parity with E2** — the value each UI writes is accepted by the matching E2 function's
  serde parse / function-runner fixtures (`discount-tier` / `discount-bundle` / `discount-special`),
  guarding the shared metafield contract against drift.
- **Parity with the monolith per type** — golden-compare the serialized output of each split UI
  against the monolith's output for the same input, per mode, to prove the split is behavior-preserving.

---

## Risks / open questions

- **Preact vs React (decided: keep Preact).** The port source is Preact and works against the admin
  UI runtime as-is; a React rewrite risks drift in the ported validators/serializer for no gain. The
  embedded app stays React/Polaris as a **separate** build — confirm no accidental cross-dependency.
- **Duplication across 3 UIs vs a shared package.** Three near-identical extensions invite copy-paste
  rot. Decision: a single `shared/` package (workspace or path import) imported by all three, with a
  CI check enforcing import-not-copy (E3-7). Open: workspace package vs relative path import given the
  Shopify CLI extension build constraints — validate the chosen mechanism builds for all three.
- **Metafield-definition migration from the old `$app:discount-engine` key.** The monolith wrote a
  single `$app:discount-engine`/`config` definition + values. The split introduces three new
  definitions/keys. Open: how do existing discounts authored under the old key migrate — a one-time
  backfill (read old key → write the matching new per-type key + create the new definition), or read
  compatibility in E2/E4? Coordinate the migration with E2 (function read key) and E4 (mirror sync);
  ensure no discount is left reading a key nothing writes.
- **`rule_type` field retention.** The function no longer needs `rule_type` to dispatch (the function
  *is* the type). Decide whether to keep `rule_type` in the JSON for the E4 `discount_config.rule_type`
  mirror column or derive it from which key is populated. Coordinate with E2-5 / E4.
- **Routing merchants to native create-discount.** The embedded app must deep-link to Shopify's
  native create-discount flow pre-scoped to the chosen app function (Tier/Bundle/Special). Open:
  confirm the exact admin deep-link/URL (or App Bridge navigation) that lands the merchant on the
  native page with the right function pre-selected, and the UX from the app's "Create discount" entry
  points (list/templates/campaigns) — this replaces the prototype's `DiscountTypeModal` → embedded
  wizard path.
- **Edit chip re-hydration for stale selections.** Titles/SKUs are stripped from storage; on edit the
  chips re-fetch by GID. Handle deleted/renamed products gracefully (id fallback, flag stale) without
  failing the whole render (ported behavior; verify under the split).
