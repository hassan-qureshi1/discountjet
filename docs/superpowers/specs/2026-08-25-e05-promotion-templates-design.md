# E5 — Promotion templates

**Date:** 2026-08-25
**Status:** Design spec — ready for planning
**Epic:** E5 — Promotion templates
**Required Shopify plan:** All (bundle-mechanic templates inherit E6's Plus gate — see §4)
**Depends on:** E3 (Discount authoring — wizard + serializer + `discountAutomaticAppCreate`/`discountCodeAppCreate`)
**Blocks:** — (leaf epic; feeds E3's create path)
**Issues:** E5-1, E5-2 (master §7)

---

## 2. Summary

Promotion templates are the merchant-friendly front door to the discount engine. A merchant
who does not know (and should never have to learn) the words "Tier function", "Cart Transform
`expand`", or "`discountClasses`" browses a gallery of plain-language promotions — "Buy more,
save more", "Bundle & save", "BOGO" — filters by intent, previews an example, and clicks **Use
template**. That drops them into E3's create flow with the correct engine mechanism, symbol, and
sensible defaults **already chosen for them**.

E5 owns two things and nothing more:

1. A **template registry** (the eight curated presets) plus a **filterable gallery** that hides
   mechanism names.
2. A thin **create-from-template** bridge that maps a template's merchant-facing `category` to
   the engine's `DiscountType` and prefills E3's authoring flow.

E5 deliberately does **not** own the create/serialize/GraphQL-write logic. That is E3's job.
E5 supplies a prefill payload; E3 renders, validates (10 KB size meter), serializes the `$app:`
metafield, and calls `discountAutomaticAppCreate` / `discountCodeAppCreate`. This spec references
E3 for that path and does not duplicate it.

---

## 3. Current state

The prototype ships a complete, static version of this surface running on hardcoded fixtures.
It is the design source of truth for E5.

- **Gallery** — `discount-engine-ui/src/pages/Templates.tsx`. Renders a `Page` titled
  "Promotion templates" with the copy "No discount jargon required." A fixed filter row
  (`FILTERS = ['All', 'Save %', 'Bundle', 'BOGO', 'Volume', 'Clearance']`) filters an in-memory
  list by `template.category`. Each template renders a `TemplateCard`; **Use template** navigates
  to `/templates/:id/create`. A footer line reinforces the promise: "Each template already
  carries its discount type underneath — you never pick a mechanism by name."
- **Card** — `discount-engine-ui/src/components/common/TemplateCard.tsx`. Emoji tile, name,
  description, an "example" chip, a `Badge` showing the `category`, and a **Use template** button.
  Note the card surfaces `category` (merchant intent), never the engine `DiscountType`.
- **Registry (fixtures)** — `discount-engine-ui/src/data/templates.json`. Eight templates, hydrated
  into the Zustand store as `Template[]` (`discount-engine-ui/src/store/useDiscountStore.ts`:
  `templates: templatesData as Template[]`, exposed via `useTemplates()` and `useTemplate(id)`).
- **Create-from-template** — `discount-engine-ui/src/pages/CreatePromotion.tsx`. A single-page
  prefilled creator (not the full wizard). It maps `category → DiscountType` via the local
  `CATEGORY_TYPE` record and picks a `symbol` from `SYMBOL`, then renders a simplified "The deal /
  Products / Method & schedule / Combinations / Summary" form. On save it calls the store's
  `addDiscount(...)` with a fabricated `id` (`d-${Date.now()}`) and navigates to `/discounts`.
- **Routes** — `discount-engine-ui/src/App.tsx`: `/templates` → `Templates`,
  `/templates/:id/create` → `CreatePromotion`. (Distinct from `/campaigns/templates` →
  `CampaignTemplates`, which is E8-8, not E5.)
- **Type** — `discount-engine-ui/src/types/index.ts`: `Template { id, emoji, name, description,
  example, category }`. Also relevant: `DiscountType = 'Tier' | 'Bundle' | 'Special'` and
  `DISCOUNT_TYPE_LABEL` (the merchant-facing labels kept alongside the engine names).

**Gaps to close in E5:**

- `CreatePromotion.tsx` is a **standalone mock form** that hardcodes the `Volume discount` badge
  (`titleMetadata={<Badge tone="magic">Volume discount</Badge>}`) regardless of the resolved type,
  writes a local fake discount, and never serializes a metafield or calls Shopify. It must be
  replaced by a bridge into **E3's real create flow**, not a parallel authoring surface.
- The registry is a static JSON fixture with no plan awareness — bundle templates are shown to
  every merchant. E5 must gate the bundle-mechanic ones on Plus (§4).
- The `category → DiscountType` map lives in two places conceptually (gallery filters +
  `CreatePromotion`); E5 consolidates it into one shared registry-level mapping.

---

## 4. Shopify plan gating

**Baseline: E5 is an All-plans feature.** Browsing templates, filtering, and previewing are pure
UI with no Shopify Function dependency, available on Basic / Shopify / Advanced / Plus.

**The exception — bundle-mechanic templates inherit E6's Plus gate.** A template's reach is
determined by the **engine mechanism its category maps to**, not by the gallery. Templates whose
`category` maps to a Cart-Transform-backed mechanism (fixed/custom bundles, `expand`/`merge`)
must inherit the **Plus-only** gate from E6/E7 (master §3: "the entire Bundles + Bundle-Campaigns
surface is Plus-only"). Concretely:

- Templates in the **`Bundle`** category — `bundle` (Bundle & save), `addon` (Main + add-on),
  `mixmatch` (Mix & match) — describe "buy these items together for one price" mechanics. Where a
  template resolves to a **Cart Transform** operation, it MUST be **gated on non-Plus** stores:
  either hidden from the gallery or shown with a clear, non-blocking upgrade prompt (never a hard
  failure), consistent with E6-2's plan-detection UX (`BundlesFeature` / shop plan).
- The current prototype maps `Bundle → 'Bundle'` **DiscountType** (a *Discount Function* Buy-X-Get-Y
  mechanic, All-plans), not a Cart Transform. **This ambiguity is an open question (§9):** "Bundle
  & save" as a *discount* is All-plans; "Bundle" as a *fixed cart-transform bundle* is Plus-only.
  The registry entry must declare which engine it targets so the gate is unambiguous. Until E6
  lands, the safe default is: keep `Bundle`-category templates that resolve to the **Discount
  Function** `Bundle`/`Special` type as All-plans, and add a distinct `bundlePlus` flag on any
  template that resolves to a **Cart Transform** — that flag drives the Plus gate.

**Rule of thumb for E5:** a template is gated **iff** the mechanism it prefills is gated. E5 never
invents its own gate; it reads the target mechanism's plan requirement (All for
Tier/Bundle/Special discount functions; Plus for Cart Transform) and reflects it in the gallery.

**App-tier (Discount Jet Starter/Growth/Scale) note:** template browsing is not tier-limited, but
**creating** from a template consumes a discount slot and is therefore subject to E11's active-count
limit at the point E3 writes the discount. E5 surfaces nothing extra here — E3's create path owns
the limit check.

---

## 5. Architecture

### Where templates live

**Decision: static registry, shipped with the frontend (not a D1 seed).**

The eight templates are curated editorial content — copy, emoji, examples — not tenant data. They
carry no `shopId`, are identical for every merchant, and change only when we ship a new build.
They stay in `discount-engine-ui/src/data/templates.json`, typed as `Template[]`, hydrated once
into the Zustand store (`useTemplates()` / `useTemplate(id)`), exactly as today. This honours the
master convention that only tenant-scoped data lives in D1 (every D1 table carries a non-null
`shopId` FK — templates have no such scope). No new table, no migration, no API route for E5.

Rejected alternatives:

- **D1 seed table** — adds a `shopId`-less global table that violates the multi-tenancy
  convention, plus a migration and a sync path, for content that ships in the bundle anyway. No
  merchant-editable requirement exists. Rejected.
- **Remote/CMS-driven registry** — over-engineered for eight static presets; defer until there is
  a product need to edit templates without a deploy (§9).

The registry is enriched (see §6) with two derived fields the prototype computes ad-hoc: the
engine `type` (`DiscountType`) and, where relevant, a `bundlePlus` plan flag. Moving these into
the registry makes the `category → mechanism` mapping single-sourced.

### Gallery + filters

Unchanged in shape from `Templates.tsx`:

- A `Page` with the jargon-free subtitle and a "Start from scratch" secondary action routing to
  E3's `/discounts/new`.
- A filter button row over the `category` axis. **Filter derivation:** rather than the hardcoded
  `FILTERS` array, derive the filter set from the registry's distinct `category` values plus a
  leading "All", so adding a template with a new category does not require editing the gallery.
- An `InlineGrid` of `TemplateCard`s; each **Use template** navigates to `/templates/:id/create`.
- **Plan-aware rendering (new):** for `bundlePlus` templates on a non-Plus store, the card renders
  a Plus badge and its primary action becomes an upgrade prompt (or the card is filtered out),
  per §4 / E6-2. The gallery reads the shop's plan from the same source E6 uses.

### Category → engine `DiscountType` mapping

The mapping is the heart of E5. It is currently in `CreatePromotion.tsx`:

```
CATEGORY_TYPE = {
  'Save %':   'Tier',
  Volume:     'Tier',
  Clearance:  'Tier',
  Bundle:     'Bundle',
  BOGO:       'Special',
}
SYMBOL = { Tier: '%', Bundle: '◱', Special: '◨' }
```

E5 promotes this into a single shared mapping consumed by both the gallery (for plan gating and
badge copy) and the create bridge (for prefill). The engine `type` resolves to E3's wizard branch;
the `SYMBOL` and the merchant-facing label come from `DISCOUNT_TYPE_LABEL`
(`types/index.ts`) so the prototype's hardcoded `<Badge>Volume discount</Badge>` is replaced by a
badge derived from the resolved type.

### How "Use" prefills E3's wizard/serializer

E5 does **not** re-implement authoring. "Use template" produces a **prefill payload** and hands off
to **E3**:

1. Gallery → navigate to the create-from-template entry (`/templates/:id/create`).
2. The bridge resolves `template.category → DiscountType` (shared map), picks the `symbol`, sets a
   default `title`/`label`, and assembles E3's initial wizard state (platform `BOTH`, method
   `automatic`, an empty `ResourcePicker` selection — "nothing is selected for you", per the
   prototype copy, defaults for amount/min-qty/schedule/combinesWith).
3. It launches **E3's authoring flow pre-seeded on the correct wizard branch** (Tier / Bundle /
   Special step from E3-2/E3-3/E3-4), with E3's **10 KB size meter** (E3-5) and validation banner
   active, and E3's **create** action wired to `discountAutomaticAppCreate` /
   `discountCodeAppCreate` + metafield write (E3-6).

The prototype's `CreatePromotion.tsx` single-page form is **superseded** by this handoff: E5
keeps the *entry point and prefill*, E3 owns the *form, validation, serialization, and write*. The
"prefill" contract is: template → `{ type, symbol, title, label, defaults }` → E3 initial state.
See `2026-08-25-e03-discount-authoring-design.md` for the wizard, serializer, and create call.

---

## 6. Template model

### Fields (existing — `types/index.ts`)

| Field | Type | Purpose | Merchant-facing? |
|---|---|---|---|
| `id` | `string` | Registry key + route param (`/templates/:id/create`). | No |
| `emoji` | `string` | Card tile glyph. | Yes |
| `name` | `string` | Plain-language promotion name ("Buy more, save more"). | Yes |
| `description` | `string` | One-line explanation. | Yes |
| `example` | `string` | Concrete example chip ("Buy 3, get 20% off"). | Yes |
| `category` | `string` | Merchant-intent bucket + filter axis + mapping key. | Yes (as badge) |

`category` is the **only** field exposed on the card that touches mechanism — and it is a merchant
word ("Bundle", "BOGO", "Volume"), never an engine word ("Cart Transform", "`expand`", "Split").

### Derived fields (added by E5's registry enrichment)

| Field | Type | Derivation | Purpose |
|---|---|---|---|
| `type` | `DiscountType` | `CATEGORY_MECHANISM[category].type` | E3 wizard branch + `symbol` + label. |
| `bundlePlus` | `boolean` | `CATEGORY_MECHANISM[category].engine === 'cartTransform'` | Drives the Plus gate (§4). |

These are computed from the shared mapping, not stored per-row (single source of truth). Keeping
them derived means a category-to-mechanism change is a one-line edit.

### The category → mechanism map (canonical)

| `category` | Engine `type` (`DiscountType`) | Engine backend | Merchant label (`DISCOUNT_TYPE_LABEL`) | Symbol | Plan |
|---|---|---|---|---|:---:|:---:|
| `Save %` | `Tier` | Discount Function | Volume discount | `%` | All |
| `Volume` | `Tier` | Discount Function | Volume discount | `%` | All |
| `Clearance` | `Tier` | Discount Function | Volume discount | `%` | All |
| `BOGO` | `Special` | Discount Function | Buy X, discount both | `◨` | All |
| `Bundle` | `Bundle` | Discount Function **or** Cart Transform (see §4/§9) | Buy X, get Y | `◱` | All / **Plus** |

The eight fixture templates (`templates.json`) resolve as: `buy-more`→Volume→Tier;
`pct-off`→Save %→Tier; `clearance`→Clearance→Tier; `bundle`→Bundle; `bxgy`→BOGO→Special;
`bogo`→BOGO→Special; `addon`→Bundle; `mixmatch`→Bundle. The three `Bundle`-category templates
(`bundle`, `addon`, `mixmatch`) are the ones whose plan gate hinges on the §9 resolution.

---

## 7. Issue breakdown

### E5-1 — Template registry + filterable gallery

**What.** Establish the enriched static registry and the plan-aware, jargon-free gallery. Keep
`templates.json` as the shipped source; add the shared `CATEGORY_MECHANISM` map (single source for
`category → { type, engine, symbol, label, plan }`); derive `type`/`bundlePlus` from it. Derive the
filter row from the registry's distinct categories (leading "All") instead of a hardcoded array.
Render the gallery via `TemplateCard`, showing `category` (never the engine name). Add plan-aware
rendering: `bundlePlus` templates on non-Plus stores show a Plus badge + upgrade prompt (or are
filtered), reading the shop plan from E6's plan-detection source; never hard-fail.

**Acceptance criteria.**
- Gallery lists all registry templates, filterable by `category`; "All" shows everything; each
  filter shows exactly the templates whose `category` matches.
- No engine mechanism name (`Tier`, `Special`, `Cart Transform`, `expand`, `merge`,
  `discountClasses`) appears anywhere in the gallery or card — only `category`, `name`,
  `description`, `example`, `emoji`.
- Filter set is derived from registry categories, so adding a template with a new category makes
  its filter appear with no gallery-code change.
- On a **non-Plus** store, `bundlePlus` templates are visibly gated (Plus badge + upgrade prompt or
  hidden), never rendered as a normally-usable card; on **Plus**, they render normally.
- "Start from scratch" secondary action routes to E3's `/discounts/new`.
- Registry stays a static frontend asset — no new D1 table, migration, or API route.

**Files touched.**
- `discount-engine-ui/src/data/templates.json` — content only (unchanged shape; verify all eight
  resolve under the shared map).
- `discount-engine-ui/src/pages/Templates.tsx` — derive filters from registry; plan-aware
  rendering; consume shared map.
- `discount-engine-ui/src/components/common/TemplateCard.tsx` — optional Plus badge / upgrade
  affordance for `bundlePlus`.
- `discount-engine-ui/src/store/useDiscountStore.ts` — registry hydration + `useTemplates()` /
  `useTemplate(id)` (extend to expose derived `type`/`bundlePlus` if computed at hydration).
- **New:** a shared mapping module (e.g. `discount-engine-ui/src/data/templateMechanism.ts`)
  holding `CATEGORY_MECHANISM` + helpers — consumed by both the gallery and the create bridge.
- `discount-engine-ui/src/types/index.ts` — extend `Template` (or a derived `ResolvedTemplate`)
  with `type`/`bundlePlus` if surfaced through the store.

### E5-2 — Create-from-template → prefilled discount (category → engine type mapping)

**What.** Replace the prototype's standalone `CreatePromotion.tsx` mock form with a thin bridge
that resolves the template via the shared map and **hands off to E3's authoring flow pre-seeded**
on the correct wizard branch with sensible defaults. Do not re-implement create/serialize/write —
reference E3-2/E3-3/E3-4 (wizard steps), E3-5 (size meter/validation), E3-6 (GraphQL create). The
resolved `type` drives the badge (from `DISCOUNT_TYPE_LABEL`), the `symbol`, and the wizard branch;
the hardcoded `Volume discount` badge is removed. Product selection stays empty ("nothing is
selected for you") using E3's `ResourcePicker` (E3-7), not the sample catalogue.

**Acceptance criteria.**
- Navigating from any template lands the merchant in E3's authoring flow on the branch matching the
  resolved `DiscountType` (`Save %`/`Volume`/`Clearance`→Tier; `BOGO`→Special; `Bundle`→Bundle),
  with title/label/symbol/method/schedule/combinesWith prefilled to the template's defaults.
- The badge/label shown reflects the **resolved** type via `DISCOUNT_TYPE_LABEL`, not a hardcoded
  string.
- Saving creates the discount through **E3's** path (`discountAutomaticAppCreate` /
  `discountCodeAppCreate` + `$app:` metafield write, 10 KB meter enforced) — E5 adds no parallel
  create/serialize logic and does not write a fake local discount.
- A `bundlePlus` template on a non-Plus store cannot reach a successful create — it is blocked at
  the gallery gate (E5-1) and, defensively, at the bridge, with an upgrade prompt rather than a
  hard error.
- Cancel/back returns to `/templates`.

**Files touched.**
- `discount-engine-ui/src/pages/CreatePromotion.tsx` — reduced to a prefill bridge into E3 (or
  removed in favour of routing into E3's create flow with prefill params); remove local
  `CATEGORY_TYPE`/`SYMBOL`/`addDiscount` mock, remove hardcoded badge.
- **New/shared:** `discount-engine-ui/src/data/templateMechanism.ts` — reused from E5-1 for the
  `category → { type, symbol, label }` resolution and the prefill payload builder.
- `discount-engine-ui/src/App.tsx` — keep/adjust the `/templates/:id/create` route to point at the
  bridge (or redirect into E3's create route with prefill state).
- E3 authoring entry (referenced, not owned here) —
  `2026-08-25-e03-discount-authoring-design.md`: the wizard shell must accept an initial prefill
  payload. Coordinate the prefill contract with E3 (this is the one cross-epic seam).

---

## 8. Testing

- **Registry resolution (unit).** Every template in `templates.json` resolves to a valid
  `DiscountType` and `symbol` under `CATEGORY_MECHANISM`; no `category` is unmapped (a new,
  unmapped category should fail the test, not silently default). Guards the "fail loudly" rule —
  no `?? 'Tier'` fallback masking a missing mapping.
- **Filter derivation (unit/component).** Filters equal `['All', ...distinct categories]`; each
  filter yields exactly the matching subset; "All" yields the full set.
- **Jargon guard (component/snapshot).** Assert no engine mechanism string
  (`Tier`/`Special`/`Cart Transform`/`expand`/`merge`/`discountClasses`) appears in rendered
  gallery/card output — only merchant vocabulary.
- **Plan gating (component).** With a non-Plus shop plan, `bundlePlus` templates render gated
  (badge/upgrade or hidden) and their create action is blocked; with Plus, they render and create
  normally. Assert non-blocking behaviour (upgrade prompt, not thrown error).
- **Prefill handoff (integration).** From each template, assert E3's flow opens on the expected
  wizard branch with the expected prefilled fields (type, symbol, label, method, schedule); assert
  the create call reaching E3 is `discountAutomaticAppCreate`/`discountCodeAppCreate` and that E5
  performs no direct GraphQL/serialization itself.
- **Route wiring.** `/templates` and `/templates/:id/create` resolve; an unknown `:id` degrades
  gracefully (redirect to `/templates`, no crash) rather than `useTemplate(id)` returning undefined
  into a blank form.
- **Regression seam with E3.** When E3's prefill contract changes, a shared type on the payload
  keeps E5 in step — assert the payload type compiles against E3's expected initial state.

---

## 9. Risks / open questions

- **`Bundle` category = discount vs Cart Transform (the central gate question).** The prototype
  maps `Bundle → Bundle` **DiscountType** (an All-plans Discount Function), but "Bundle & save" /
  "Mix & match" / "Main + add-on" describe mechanics that E6 implements as **Plus-only Cart
  Transforms**. Until E6 lands, the registry must explicitly declare each `Bundle`-category
  template's target engine (`discountFunction` vs `cartTransform`) so `bundlePlus` — and therefore
  the Plus gate — is unambiguous. **Recommendation:** default `Bundle`-category templates to the
  All-plans Discount Function `Bundle` type; add `bundlePlus` only to templates that genuinely
  require Cart Transform, and coordinate the split with E6-2's plan detection. **Owner decision
  needed before E5-1 ships.**
- **Prefill contract coupling with E3.** E5's only cross-epic seam is the prefill payload E3's
  wizard must accept. If E3's initial-state shape drifts, E5's handoff breaks. Mitigate with a
  shared payload type owned by E3 and imported by E5; do not let E5 reach into E3 internals beyond
  that type.
- **Superseding `CreatePromotion.tsx`.** Removing the standalone form is a deliberate behaviour
  change from the prototype (which writes a local fake discount and shows a hardcoded badge).
  Confirm no other route/screen links into that mock form's fields before deleting; the prototype
  copy ("Saved to Discounts on activate") must map to E3's real create result.
- **Static registry vs future editability.** Shipping templates in `templates.json` means a copy
  or new-template change needs a deploy. Acceptable now (eight curated presets). If product later
  wants merchant- or admin-editable templates, revisit a D1/remote source — but that would need a
  `shopId`-scoped model (per-shop) or a deliberately global, convention-excepted table, and a sync
  path. Explicitly out of scope for E5.
- **Filter/category divergence.** Deriving filters from registry categories removes the hardcoded
  `FILTERS` list; ensure ordering is stable/curated (e.g. a defined category order) rather than
  incidental JSON order, so the gallery's filter row does not reshuffle when templates are added.
- **App-tier limit at create time.** Creating from a template consumes a discount slot; the E11
  active-count limit is enforced in E3's create path, not E5. A merchant browsing an enticing
  template then hitting the limit on save is an E3/E11 UX concern E5 should be aware of (consider a
  soft hint), but E5 owns no limit logic.
