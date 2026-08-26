# Discount Jet — Feature Decomposition & Roadmap (Master Spec)

**Date:** 2026-08-25
**Status:** Approved decomposition — per-epic specs follow
**Scope:** Full app, all epics, layered build order
**Distribution model:** **Public app** (Shopify App Store / unlisted-public) — see [§Distribution decision](#distribution-decision)

---

## 1. Purpose

This document decomposes the Discount Jet app into 12 epics and ~60 issues, in build order,
each tagged with the **merchant's required Shopify plan**. It is the index for the per-epic
spec files in this directory (`2026-08-25-e01-*.md` … `e12-*.md`) and the source of truth for
the issue-card Artifact.

Two prior inputs drove this:

- **Backend** (`/src`) is still the unmodified `cloudflare-shopify-starter` template: OAuth
  install, session-token auth, KV sessions, one `shopify_shop` table, one `app/uninstalled`
  webhook. **The entire discount engine is greenfield.**
- **UI prototype** (`/discount-engine-ui`) is a faithful React + Polaris prototype running on
  hardcoded JSON fixtures. It is the **design source of truth** for the *embedded app* surface
  (lists, templates, campaigns, bundles orchestration).
- **`eva/discount-engine`** (`/Users/hassanahmed/code/eva/discount-engine`) is the **working
  extension app** and the **port source** for the Shopify Functions. It currently ships a
  *monolithic* JS-compiled-to-Wasm discount function (three handlers — tier/bundle/special —
  dispatched by a `rule_type` field) + one Preact admin UI extension rendering all three modes,
  plus a separate `cart-transformer` function. Scopes: `write_discounts, write_cart_transforms,
  read_products`; API version `2026-01`; targets `cart.lines.discounts.generate.run` +
  `cart.delivery-options.discounts.generate.run`; config metafield `$app:discount-engine.config`.

---

## 1a. Architecture decisions (2026-08-25 revision)

These four decisions were confirmed after reviewing both repos and **supersede** the original
E2/E3 shape. They are reflected in §4, §7, and the E1–E3 specs.

1. **Rust rewrite.** The three discount functions are rewritten from JS → **Rust**
   (Shopify-recommended, most performant for large carts).
2. **3 fully independent extensions.** The monolith is split into **three discount function
   extensions** (`discount-tier`, `discount-bundle`, `discount-special`) — each with its **own
   handle + uid + metafield key** — and **three matching admin UI extensions**. Not one function
   with `rule_type` dispatch. (The existing `tier`/`bundle`/`split-discount` git worktree branches
   are the starting point but still share a uid/handle/key — that must be un-shared.)
3. **Single app in `discount-jet`.** All extensions are **migrated into `discount-jet/extensions/`**
   so there is ONE Shopify app: Cloudflare Worker backend + embedded React/Polaris admin UI +
   the Shopify Function & admin-UI extensions. `eva/discount-engine` is the source to port from.
4. **Per-function admin UI authoring.** A merchant configures a discount on **Shopify's native
   discount page**, where the relevant **admin UI extension** (`admin.discount-details.
   function-settings.render`) writes the metafield. There is **no app-owned create mutation for
   manual authoring**. `discountAutomaticAppCreate` is used **only** for *programmatic* creation
   from templates (E5) and campaigns (E8), which write the same metafield contract.

---

## 2. Distribution decision

**Chosen: public-app distribution.**

Shopify Functions plan gating (from official docs, verified 2026):

> "Stores on any plan can use public apps that are distributed through the Shopify App Store and
> contain functions." … "Only stores on a Shopify Plus plan can use custom apps that contain
> Shopify Function APIs."

**Consequence:** distributing Discount Jet as a **public app** lets the discount engine
(E2/E3) run on **Basic, Shopify, Advanced, and Plus**. A *custom* (single-store) app containing
Functions would be **Plus-only** — rejected, because it would exclude the majority of the target
market and contradict the prototype's multi-tier plan page.

This does **not** lift the Cart Transform gate — see below.

---

## 3. Shopify plan gating reference

Two distinct axes. Do not conflate them.

- **Shopify plan** = the *merchant's* Shopify subscription (Basic / Shopify / Advanced / Plus).
  Set by Shopify's platform limits. This is what "which feature in which Shopify plan" refers to.
- **App tier** = *Discount Jet's own* pricing (Starter / Growth / Scale). Our commercial choice,
  enforced by our reconcile job (E11). Independent of the Shopify plan.

### Shopify-plan capability matrix

| Capability | Basic | Shopify | Advanced | Plus | Source of gate |
|---|:---:|:---:|:---:|:---:|---|
| Discount Functions via **public app** (Tier / BXGY / Split) | ✅ | ✅ | ✅ | ✅ | Public apps with Functions run on any plan |
| Discount code + automatic app discounts | ✅ | ✅ | ✅ | ✅ | Admin GraphQL, all plans |
| Discount → webhook → D1 sync, lists, templates, campaigns of discounts | ✅ | ✅ | ✅ | ✅ | No Function gate |
| Cart Transform **`expand`** (fixed bundles) | ✅ | ✅ | ✅ | ✅ | No plan-tier gate; only `update` is Plus-gated |
| Cart Transform **`merge`** (custom bundles) | ✅ | ✅ | ✅ | ✅ | No plan-tier gate; only `update` is Plus-gated |
| Cart Transform **`update`** (line price/title/image override) | ❌ | ❌ | ❌ | ✅ | "Only development stores or stores on a Shopify Plus plan can use apps with `update` operations" (stated globally, twice) |
| Bundles (create/list via expand + merge) | ✅ | ✅ | ✅ | ✅ | Built on expand/merge; store eligibility via `BundlesFeature` |
| Bundle campaigns (priced via merge/expand) | ✅ | ✅ | ✅ | ✅ | Bundle price carried on the merge/expand operation, not `update` |
| Discounts Allocator Function (custom allocation) | ❌ | ❌ | ❌ | ✅ (preview) | "available only to Shopify Plus merchants"; API unstable |
| Storefront upsell widget (theme app extension) | ✅ | ✅ | ✅ | ✅ | Theme app extensions, all plans |

Dev stores unlock the `update` operation for build/test regardless of the live-plan gate.

**Product rule (corrected 2026-08-25):** Bundles are **NOT** an all-or-nothing Plus feature. Per the
current Cart Transform docs (verified against `cart-transform.md`), the Plus gate applies **only to
the `update` operation** — the sentence *"Only development stores or stores on a Shopify Plus plan can
use apps with `update` operations"* names `update`/`lineUpdate` alone. `expand` and `merge` appear
only in the **selling-plan-rejection** sentence (*"Shopify rejects lineExpand, linesMerge, and
lineUpdate operations if a selling plan is present"*), which is a cart-contents rule, not a plan-tier
gate. Therefore: **bundle creation and bundle campaigns (E6, E7) run on all plans**; only the
`update` operation (overriding price/title/image on an existing single line — E6-5) is **Plus-only**.
Store eligibility is still checked via the `BundlesFeature` GraphQL object; gate the `update`-based
feature with an upgrade prompt, never a hard failure.

---

## 4. Shopify Functions / API facts the specs rely on

Locked technical decisions (from official shopify.dev docs, 2026, cross-checked against the
working `eva/discount-engine` extensions):

- **Discount Function API:** target the **unified Discount Function API** —
  `cart.lines.discounts.generate.run` (product + order) and
  `cart.delivery-options.discounts.generate.run` (shipping, a no-op today), driven by
  `discountClasses` (`PRODUCT` / `ORDER` / `SHIPPING`). This matches `eva/discount-engine`'s live
  `discount-function` (API version `2026-01`). The legacy per-class product/order/shipping
  discount functions are **deprecated** — do not build against them.
- **Three independent functions in Rust.** Split the monolith into **`discount-tier`**,
  **`discount-bundle`**, **`discount-special`** — each its own function extension (distinct
  `handle`/`uid`), each **rewritten in Rust** from the corresponding JS handler
  (`tier_discount.js` / `bundle_discount.js` / `special_discount.js`). No `rule_type` runtime
  dispatch — the function *is* the type.
- **Per-function admin UI extension.** Each function pairs to its own **Preact/React admin UI
  extension** at `admin.discount-details.function-settings.render`, linked via
  `[extensions.ui] handle = "…"`. The UI renders **only its type's** config (no mode select),
  ensures the metafield **definition** exists (`metafieldDefinitionCreate`, ownerType `DISCOUNT`,
  `type: json`, access `MERCHANT_READ_WRITE`), and writes config via `shopify.applyMetafieldChange`.
- **Config transport:** a **per-function `$app:`-namespaced metafield on the DISCOUNT** owner,
  `type: json`. Un-share the monolith's single `$app:discount-engine.config` into distinct keys —
  `$app:discount-tier.config`, `$app:discount-bundle.config`, `$app:discount-special.config`.
  **Hard cap: 10,000 bytes** returned to the function (larger → `null`); the admin UI enforces it
  with the size meter (ported from `useExtensionData.js`).
- **Manual vs programmatic creation.** *Manual* discounts are created on Shopify's **native
  discount page** (merchant picks the app function → our admin UI extension renders inline →
  writes the metafield); the app runs **no** create mutation for this path. *Programmatic*
  creation (templates E5, campaigns E8) uses **`discountAutomaticAppCreate`** / `discountCodeAppCreate`
  (`functionId`, `combinesWith`, `discountClasses`, `metafields`) writing the **same** metafield
  contract. The GraphQL Admin client (E1) is needed for this, plus sync (E4), cart transform (E6),
  and billing (E11) — not for manual authoring.
- **Cart Transform:** already exists in `eva/discount-engine` as the JS `cart-transformer`
  function (`cart.transform.run`) — E6 ports it (Rust rewrite TBD, see E6). Register with
  **`cartTransformCreate`** (`functionHandle`, `blockOnFailure`,
  `metafields`). One cart transform per app per store. **2000** max expand/merge quantity.
  Operations **rejected when a selling plan / subscription is in the cart**. Component data lives
  in **variant metafields** (`custom.component_reference`, `list.variant_reference`).
- **Limits:** max **25 active discount functions** per store; function input **128 kB**,
  output **20 kB**.

---

## 5. Shared conventions (all epics)

Inherited from root `CLAUDE.md` — every epic spec must honor these:

- **IDs:** `crypto.randomUUID()`, never auto-increment.
- **Timestamps:** ISO 8601 strings in `text()` columns.
- **Multi-tenancy:** every new table carries a non-null `shopId text` FK →
  `shopify_shop.id`, `onDelete: 'cascade'` (GDPR `SHOP_REDACT`).
- **Route security:** all `/api/*` protected by `requireShop`; public routes require an explicit
  `PUBLIC_API_PATHS` entry with justification.
- **Sessions:** always `KVSessionStorage.loadSession()`, never raw `KV.get()` + `JSON.parse()`.
- **Fail loudly:** no `?? ''` fallbacks masking a missing domain/ID/required field.
- **Secrets:** never in queue messages; fetch tokens from KV at processing time.
- **UI:** React 18 + Polaris 13 + React Router 6 + Zustand. Replace JSON fixtures with API calls
  behind the existing selector hooks (`useDiscounts`, `useCampaigns`, …) without changing pages —
  the prototype was built for this swap.

---

## 6. Core data model (D1, additive)

New tables all reference `shopify_shop.id`. Detailed columns live in each epic spec; this is the
shared shape and ownership map.

| Table | Owner epic | Purpose |
|---|---|---|
| `discount` | E4 | App-tracked mirror of Shopify discounts (synced via webhook). `shopifyGid`, name, type (`tier`/`bundle`/`special`), method (`automatic`/`code`), status, product count, `campaignId?`, timestamps. |
| `discount_config` | E4 | Read-only **mirror** of the function-config metafield JSON (+ size bytes, `rule_type`), synced from `discounts/*` webhooks. Authoritative copy lives on the Shopify discount metafield, written by the E3 admin UI extension. |
| `cart_transform` / `bundle` | E6 | Bundle definitions: operation (`merge`/`expand`/`update`), items, price, metafield state. **Plus-only surface.** |
| `bundle_campaign` + `bundle_campaign_bundle` | E7 | Scheduled bundles with campaign/compare-at pricing. |
| `campaign` | E8 | Groups discounts + bundles on a schedule; publish log; ownership lock. |
| `campaign_discount` / `campaign_bundle` | E8 | Join rows; campaign-owned discounts are read-only. |
| `plan_state` | E11 | Current app tier, usage count, reconcile status. |
| `webhook_event` | E1 | Idempotency + audit for inbound webhooks. |
| `notification` | E9 | Email-notify recipients + send log for campaign activation. |

---

## 7. Epic & issue registry

Build order is top-to-bottom. `SP` = required Shopify plan. Dependencies reference epics.

### E1 — Backend foundations & app setup · SP: All · deps: —
Turn the starter into a discount-app platform and the single home for all extensions.
- **E1-1** Set scopes to match the extension app: `write_discounts`, `write_cart_transforms`, `read_products` (+ `read_orders` retained for analytics).
- **E1-2** Add `shopify.app.toml` + Shopify CLI app config; create `extensions/` and **migrate** the `eva/discount-engine` extensions in; **public-app distribution** setup; provision real Worker name + D1/KV ids.
- **E1-3** Typed **GraphQL Admin API client** (cost-aware, retry/backoff, offline-token via `getShopAccessToken`) — for templates/campaigns creation, sync, cart-transform registration, billing. *Not* used for manual discount authoring.
- **E1-4** Core discount **D1 schema** (`discount`, `discount_config`, `webhook_event`) + Drizzle migration.
- **E1-5** **GDPR mandatory webhooks**: `customers/data_request`, `customers/redact`, `shop/redact`.
- **E1-6** Webhook infra: register `discounts/*` topics; queue-backed processing scaffold + idempotency via `webhook_event`.

### E2 — Discount function extensions (3 × Rust) · SP: All* · deps: E1
Split the `eva/discount-engine` monolith into **three independent Rust functions**, ported from
the JS handlers. Each targets `cart.lines.discounts.generate.run` (+ delivery no-op), owns its
`handle`/`uid`, and reads its own `$app:discount-<type>.config` metafield.
- **E2-1** Rust function workspace under `extensions/` (Cargo, `shopify_function` bindings, JS→ removed, wasm build) + shared input-query/config-parse conventions.
- **E2-2** **`discount-tier`** (Rust) — port `tier_discount.js`: qty tiers, % or fixed, ALL/FIRST/MAXIMUM strategy, per-line `min_qty`, price vs compare-at.
- **E2-3** **`discount-bundle`** (Rust) — port `bundle_discount.js`: source/target sets, `quantity_dependent`, `fixed_ratios`, `shared_pool`, `max_target_qty`, `target_per_source`.
- **E2-4** **`discount-special`** (Rust) — port `special_discount.js`: separate discounts on source **and** multiple target groups, each with own operator/value/message.
- **E2-5** Per-function config **serde structs** mirroring the JS shapes; discount-code matching + `checkout:priority_codes` shop metafield; distinct metafield keys.
- **E2-6** Shared concerns per function: platform (BOTH/POS/CHECKOUT), `discountClasses`, `combinesWith`, delivery-options target.
- **E2-7** Rust test suite (function-runner fixtures) per function, ported from `local/` payloads + `docs/*.md` examples.
- \*All-plan reach requires public-app distribution (E1-2).

### E3 — Per-function admin UI extensions (authoring) · SP: All · deps: E2
Split the monolithic Preact `discount-ui` into **three admin UI extensions**, one per function.
Authoring happens on Shopify's **native discount page**; each UI renders only its type's config
and writes the metafield. **No embedded wizard / no create mutation** for manual authoring.
- **E3-1** Admin UI extension scaffolding + **metafield-definition management** (`metafieldDefinitionCreate`, ownerType `DISCOUNT`, `type: json`, per-function namespace/key) + shared UI patterns (resource picker, ConfigurationPreview, 10 KB meter, validation) ported from `discount-ui`.
- **E3-2** **Tier** admin UI extension (`TierCard`) → linked to `discount-tier`.
- **E3-3** **Bundle** admin UI extension (`BundleDiscountCard`) → `discount-bundle`.
- **E3-4** **Special/Split** admin UI extension (`SpecialDiscountCard`) → `discount-special`.
- **E3-5** Metafield write path (`applyMetafieldChange`) + **10 KB** enforcement + live validation banner (from `useExtensionData.js`); remove the `rule_type` mode select (each UI is single-type).
- **E3-6** Live resource hydration (`useResourceDetails` — fetch product/variant title/sku/image from Admin API; persist IDs only) + `shopify.resourcePicker`.
- **E3-7** Framework decision (keep Preact vs move to React) + shared component library across the 3 UIs.

### E4 — Discount sync + list/detail · SP: All · deps: E1
Shopify is the source of truth; D1 is the queryable mirror.
- **E4-1** `discounts/create|update|delete` webhook handlers → upsert `discount`.
- **E4-2** Discounts **list** (IndexTable, status tabs, live counts, campaign badge).
- **E4-3** Discount **detail** (read-only, campaign-lock banner).
- **E4-4** **Native Shopify discounts** view (app + native side by side).
- **E4-5** Sync-health surface + backfill/reconcile action.

### E5 — Promotion templates · SP: All · deps: E3
Merchant-friendly entry that hides mechanism names.
- **E5-1** Template registry + filterable gallery.
- **E5-2** Create-from-template → prefilled discount (category → engine type mapping).

### E6 — Cart Transform extension + Bundles CRUD · SP: All (`update` op: Plus) · deps: E1
Bundles via the Cart Transform Function. **`expand` and `merge` run on all plans; only the
`update` operation is Plus-gated.**
- **E6-1** Rust cart-transform function + `cartTransformCreate` registration (`blockOnFailure`).
- **E6-2** **Plan gating for `update` only**: detect Plus via `BundlesFeature`/shop plan; gate the `update`-based feature with an upgrade-prompt UI (no hard fail). `expand`/`merge` need no plan gate. Store-eligibility check via `BundlesFeature` still applies to all.
- **E6-3** `merge` (custom bundles) + variant `component_reference` metafields — **all plans**.
- **E6-4** `expand` (fixed bundles, 2000 cap, component pricing/image/title) — **all plans**.
- **E6-5** `update` (line price/title/image override) — **Plus only**.
- **E6-6** Bundles **list + editor** CRUD.
- **E6-7** Selling-plan/subscription guard (rejects expand/merge/update when a selling plan is in cart); `blockOnFailure` policy; one-transform-per-store handling.

### E7 — Bundle campaigns · SP: All · deps: E6, E9
Schedule bundles with campaign pricing. Bundle price is carried on the **merge/expand** operation
(all plans), so bundle campaigns are not Plus-gated. (Only a campaign that relied on the `update`
line-override op would need Plus — call that out in the editor if such a mode is added.)
- **E7-1** `bundle_campaign` model + list (status tabs, empty state).
- **E7-2** Editor — per-bundle campaign price + compare-at, scheduled window, shopper preview.
- **E7-3** Metafield write/clear on schedule (executes via E9 cron).

### E8 — Campaigns · SP: All · deps: E3, E6
Group discounts + bundles on a schedule with a publish orchestration.
- **E8-1** `campaign` model + list (tabs, metrics, clone).
- **E8-2** 5-step builder shell (Details / Discounts / Bundles / Schedule / Review).
- **E8-3** Discounts step — reuse discount wizard in modal; **ownership lock** (`campaignId`).
- **E8-4** Bundles step — multi-select (all plans; a bundle using the `update` op would need Plus).
- **E8-5** **Publish orchestration** — create locked discounts via GraphQL, write metafields, publish log.
- **E8-6** **CSV import** (documented column contract).
- **E8-7** Campaign detail + publish log + clone-to-edit.
- **E8-8** Campaign templates gallery.

### E9 — Campaign scheduling cron · SP: All · deps: E1
Time-based activation/deactivation (the ≤5 min cron the prototype references).
- **E9-1** Cron trigger + `wrangler.jsonc` config; token refresh in background context.
- **E9-2** Activation pass — publish scheduled discounts/bundles, write metafields.
- **E9-3** Deactivation pass — clear metafields, deactivate expired discounts.
- **E9-4** **Email notifications** on activate/deactivate (multi-recipient, from `EmailTagField`).

### E10 — Storefront upsell widget · SP: All · deps: E3
On-storefront upsell rendering + designer.
- **E10-1** Theme app extension scaffold (app embed / app block).
- **E10-2** Storefront widget rendering (PDP / cart & drawer / sticky footer).
- **E10-3** Upsell Designer UI + config persistence.
- **E10-4** Live preview (PDP + cart views).

### E11 — Plan, limits & billing · SP: All · deps: E1
Discount Jet's own commercial tier (not the Shopify plan).
- **E11-1** **Shopify Billing** (managed pricing / `appSubscriptionCreate`).
- **E11-2** App-tier model (Starter 10 / Growth 50 / Scale 200) + entitlements.
- **E11-3** **Reconcile job** — active count vs limit, deactivate newest over-limit discount.
- **E11-4** Plan & limits UI (usage meter, tiers table).

### E12 — Overview dashboard & analytics · SP: All · deps: E4
- **E12-1** Overview KPIs + aggregation (active discounts, bundles, plan usage).
- **E12-2** Recent activity feed (from webhook events).
- **E12-3** Bundle schedule widget.
- **E12-4** Webhook sync-health indicator.

---

## 8. Dependency graph

```
E1 ──┬─> E2 ──> E3 ──┬─> E5
     │               ├─> E8 ──> (E9)
     │               ├─> E10
     │               └─> (E11 uses counts)
     ├─> E4 ──> E12
     ├─> E6 ──> E7
     ├─> E9 ──> E7 (bundle campaign scheduling)
     └─> E11
```

Critical path to a shippable v1: **E1 → E2 → E3 → E4** (create + apply + track discounts).
Bundles (E6/E7) are an independent track off E1 — all-plans, except the Cart Transform `update`
operation (E6-5), which is the only Plus-gated capability in the whole app.

---

## 9. Per-epic spec files

| Epic | Spec file |
|---|---|
| E1 | `2026-08-25-e01-backend-foundations-design.md` |
| E2 | `2026-08-25-e02-discount-function-design.md` |
| E3 | `2026-08-25-e03-discount-authoring-design.md` |
| E4 | `2026-08-25-e04-discount-sync-list-design.md` |
| E5 | `2026-08-25-e05-promotion-templates-design.md` |
| E6 | `2026-08-25-e06-cart-transform-bundles-design.md` |
| E7 | `2026-08-25-e07-bundle-campaigns-design.md` |
| E8 | `2026-08-25-e08-campaigns-design.md` |
| E9 | `2026-08-25-e09-scheduling-cron-design.md` |
| E10 | `2026-08-25-e10-storefront-upsell-design.md` |
| E11 | `2026-08-25-e11-plan-limits-billing-design.md` |
| E12 | `2026-08-25-e12-overview-analytics-design.md` |

Next step after review: run `superpowers:writing-plans` per epic to turn each spec into an
implementation plan, starting with the critical path E1 → E4.
