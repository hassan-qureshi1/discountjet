# E2 — Discount function extensions (3 × Rust)

| | |
|---|---|
| **Date** | 2026-08-25 |
| **Status** | Draft spec (rewritten for the 3-independent-Rust-function architecture — supersedes the earlier single-function draft) |
| **Epic** | E2 — Discount function extensions |
| **Shopify plan** | **All\*** (Basic / Shopify / Advanced / Plus) — \*all-plan reach requires **public-app distribution** (E1-2) |
| **App tier** | Any (Starter / Growth / Scale) — active-count enforced by E11 |
| **Depends on** | **E1** (OAuth scopes `write_discounts`/`read_products`, `shopify.app.toml` + `extensions/` dir, GraphQL Admin client, `discount`/`discount_config` schema, webhook infra) |
| **Blocks** | **E3** (the three admin UI extensions each write the per-function metafield contract defined here) |
| **Language** | **Rust** (`shopify_function` crate + `serde`, compiled to Wasm) |
| **API** | Unified Discount Function API, **api_version `2026-01`** |
| **Port source** | `eva/discount-engine/extensions/discount-function/` (JS monolith) + `.worktrees/{tier,bundle,split-discount}/` (exploratory split) + `discount-ui/src/hooks/useExtensionData.js` (config shapes) |

---

## Summary

E2 delivers the **on-platform discount engine** as **three independent Shopify Function
extensions**, each **rewritten in Rust** from the corresponding JavaScript handler in the
`eva/discount-engine` monolith:

| Extension | Handle | Ports | Reads metafield |
|---|---|---|---|
| **discount-tier** | `discount-tier` | `tier_discount.js` | `$app:discount-tier.config` |
| **discount-bundle** | `discount-bundle` | `bundle_discount.js` | `$app:discount-bundle.config` |
| **discount-special** | `discount-special` | `special_discount.js` | `$app:discount-special.config` |

The monolith today is **one** JS-compiled-to-Wasm function (`handle = "discount-function"`,
`uid = 630829f6-…`, api_version `2026-01`) whose `shopify-discount-applier.js` coordinator
inspects a `rule_type` field in a **single** `$app:discount-engine.config` metafield and dispatches
to one of three handlers. E2 **eliminates that runtime dispatch**: each function *is* its type, so
there is no coordinator, no `rule_type` branch, and no shared config key. Each extension exports the
two unified Discount Function API run targets — `cart.lines.discounts.generate.run` (product/order)
and `cart.delivery-options.discounts.generate.run` (shipping, a no-op today) — parses **only its
own** config shape, and emits a single `productDiscountsAdd` operation.

Because Discount Jet ships as a **public app** (E1-2), all three functions run on **every Shopify
plan** — the strategic reason E2 is not Plus-gated (unlike the Cart Transform work in E6). The
per-function config schemas in *Per-function config contracts* are the **shared contract** with E3:
each E3 admin UI extension writes exactly the JSON its paired function parses, and both sides enforce
the same 10 KB metafield budget.

The Rust ports must be **behaviour-faithful** to the JS handlers, including the non-obvious details
(per-line `min_qty` for tier, OR-logic source-qty for bundle/special, the `fixed_ratios` /
`max_target_qty` / `shared_pool` entitlement math, the message-only source candidates in bundle, the
per-target-group selection strategy in special, and the `checkout:priority_codes` discount-code
yield). *Engine semantics* below records each behaviour precisely, read off the actual source.

---

## Current state

### The `eva/discount-engine` monolith (the port source)

One function extension at `extensions/discount-function/`:

- **`shopify.extension.toml`** — `api_version = "2026-01"`, `handle = "discount-function"`,
  `uid = "630829f6-2180-df6b-6a08-656aa871d3f31c3e344a"`, two targets
  (`cart.lines.discounts.generate.run`, `cart.delivery-options.discounts.generate.run`), and
  `[extensions.ui] handle = "discount-ui"` linking the one admin UI extension.
- **`src/cart_lines_discounts_generate_run.graphql`** — the input query. Reads
  `triggeringDiscountCode`; `cart.attribute(key: "platform_source")` (POS/CHECKOUT detection);
  `cart.discountCode: attribute(key: "discountCode")`; per line `id`, `quantity`,
  `cost { subtotalAmount, amountPerQuantity, compareAtAmountPerQuantity }`, and
  `merchandise … on ProductVariant { id, product { id } }`; `discount.discountClasses`;
  `discount.metafield(namespace: "$app:discount-engine", key: "config")`; and
  `shop.metafield(namespace: "checkout", key: "priority_codes")`.
- **`src/shopify-discount-applier.js`** — the coordinator. Parses the config JSON, normalizes
  `rule_type` (lowercase, `-`→`_`, default `tier_discount`), resolves selection strategy /
  `apply_to` / `platform`, detects current platform from the cart attribute, does discount-code
  matching against the shop metafield, then **lazy-loads** exactly one of the three handlers and
  returns its `productDiscountsAdd` operations.
- **`src/tier_discount.js`**, **`src/bundle_discount.js`**, **`src/special_discount.js`** — the three
  handlers ported below.
- Language today is **JS → Wasm** (compiled via the JS Function runtime).

### The three exploratory worktree branches (the starting point — flawed)

`.worktrees/{tier,bundle,split-discount}/extensions/discount-function/` each strip the monolith down
to a single handler (tier keeps `tier_discount.js`, bundle keeps `bundle_discount.js`, split-discount
keeps `special_discount.js`), all still JS. **They are the seed of the split but not yet independent:**
every one of the three `shopify.extension.toml` files still declares the **same**
`handle = "discount-function"`, the **same** `uid = "630829f6-…"`, the **same**
`[extensions.ui] handle = "discount-ui"`, and each input query still reads the **same**
`$app:discount-engine` metafield namespace. They are also pinned to the **older** `api_version =
"2025-04"`. **Un-sharing all four of these (handle, uid, ui-handle, metafield key) and re-pinning to
`2026-01` is a required part of E2** (E2-1/E2-6) — see *Risks*.

### Discount-jet target repo

`discount-jet/extensions/` is created in E1-2 (which migrates the `eva` extensions into this repo).
E2 is the first set of extensions to live there, rewritten in Rust.

---

## Shopify plan gating

**All plans, via public-app distribution.** Per master §2/§3 and official docs:

> "Stores on any plan can use public apps that are distributed through the Shopify App Store and
> contain functions." … "Only stores on a Shopify Plus plan can use custom apps that contain
> Shopify Function APIs."

Consequences that bind E2:

- Distributing Discount Jet as a **public app** (E1-2) is what lets all three functions run on
  **Basic, Shopify, Advanced, and Plus**. A *custom* (single-store) app carrying Functions would be
  **Plus-only** — explicitly rejected.
- **The 25-active-discount-functions cap per store (master §4) now matters MORE.** With the monolith
  a merchant spent **one** of their 25 function slots regardless of how many discount *types* they
  used. After the split, a merchant running tier **and** bundle **and** special simultaneously
  consumes **three** slots — plus the Cart Transform function (E6) is a fourth registered function.
  The functions themselves do not enforce the cap; **E11's reconcile job** does, reconciling against
  `min(shopifyCap=25, appTierCap)`. E2's design must not assume unlimited active discounts, and the
  test suite includes the "activation blocked at cap" path as an *environment constraint*, not a
  function output.
- **Out of scope / contrast — the Discounts Allocator Function** is **Plus-only and in preview** with
  an unstable API (master §3). E2 deliberately does **not** build against it. Allocation order across
  multiple discounts stays with Shopify's default allocator; our functions only *generate* candidate
  discounts and declare `combinesWith` at registration.
- POS reach: each function honours the config `platform` field (`BOTH`/`POS`/`CHECKOUT`) at runtime
  by comparing it against the platform detected from the cart attribute (see *Engine semantics*).

---

## Target architecture

### Three-extension layout

```
discount-jet/extensions/
  discount-tier/
    shopify.extension.toml         # handle discount-tier,   uid <new-1>, ui discount-tier-ui
    Cargo.toml
    src/
      main.rs                      # #[shopify_function] run targets
      cart_lines_run.rs            # cart.lines.discounts.generate.run
      delivery_run.rs              # cart.delivery-options... (no-op)
      config.rs                    # serde structs for tier config
      engine.rs                    # ported tier_discount.js
      shared.rs                    # id-from-gid, line matching, qty sums, operation builder, code-yield
      cart_lines_run.graphql
      delivery_run.graphql
  discount-bundle/                 # same shape; handle discount-bundle, uid <new-2>, ui discount-bundle-ui
  discount-special/                # same shape; handle discount-special, uid <new-3>, ui discount-special-ui
```

Each extension is a **standalone Cargo package** producing its own `dist/function.wasm`.

### Distinct handle / uid / metafield key — the un-sharing requirement

The worktrees reuse one identity across all three. E2 **must un-share** every axis:

| Axis | Monolith / worktrees (shared) | discount-tier | discount-bundle | discount-special |
|---|---|---|---|---|
| `handle` | `discount-function` | `discount-tier` | `discount-bundle` | `discount-special` |
| `uid` | `630829f6-…` (one) | **new uid** | **new uid** | **new uid** |
| `[extensions.ui] handle` | `discount-ui` | `discount-tier-ui` | `discount-bundle-ui` | `discount-special-ui` |
| config metafield | `$app:discount-engine`/`config` | `$app:discount-tier`/`config` | `$app:discount-bundle`/`config` | `$app:discount-special`/`config` |
| shop code metafield | `checkout`/`priority_codes` | (shared, shop-level) | (shared, shop-level) | (shared, shop-level) |

Notes:
- Each `uid` must be a **freshly generated** UUID — reusing the monolith's uid across extensions is
  invalid (a uid identifies one extension). Generate three distinct uids at scaffold time.
- The **shop** metafield `checkout:priority_codes` is shop-scoped, not discount-scoped, so all three
  functions legitimately read the *same* shop metafield — this one is **not** un-shared.
- `rule_type` is **not** read for dispatch anymore. If E3 still serializes a `rule_type` field into
  the metafield, each function **ignores** it (the function *is* the type). `serde` must tolerate the
  extra field.

### Rust toolchain

- **`shopify_function` crate** for the target macros / codegen + **`serde`/`serde_json`** for config
  deserialization; compiled to `wasm32-*` via the Shopify CLI (`shopify app build`) using
  `[extensions.build] path = "dist/function.wasm"`.
- **Three fully independent extensions** (master §1a decision 2). A **thin shared crate** for the
  common cart-input plumbing (GID parsing, line matching, quantity sums, the `productDiscountsAdd`
  builder, and the discount-code yield check) is **OPTIONAL and deferred** — see *Risks / open
  questions*. The default is to duplicate `shared.rs` per extension so each ships independently; a
  shared crate is a later DRY optimization, not a requirement.

### Targets

Every extension exports **both** run targets:

| Target | Emits | Today |
|---|---|---|
| `cart.lines.discounts.generate.run` | `PRODUCT` (and `ORDER` where granted) | all real work |
| `cart.delivery-options.discounts.generate.run` | `SHIPPING` | **no-op** — returns empty operations |

Each target only emits classes the discount was granted via `discountClasses` (declared at creation
by E3 / programmatic create). All three rule types are **`PRODUCT`-class** today.

### The `[extensions.ui]` link (to E3)

Each `shopify.extension.toml` declares `[extensions.ui] handle = "discount-<type>-ui"`, binding the
function to its **own** admin UI extension (E3) at `admin.discount-details.function-settings.render`.
The UI renders only that type's config and writes the matching per-function metafield.

### Manual vs programmatic creation (both write the same metafield)

- **Manual authoring** — merchant creates the discount on **Shopify's native discount page**, picks
  the app function (`discount-tier` / `discount-bundle` / `discount-special`), and the paired E3
  admin UI extension renders inline and writes `$app:discount-<type>.config` via
  `shopify.applyMetafieldChange`. **No app-owned create mutation** runs on this path.
- **Programmatic creation** — templates (E5) and campaigns (E8) call `discountAutomaticAppCreate` /
  `discountCodeAppCreate` (with `functionId`, `combinesWith`, `discountClasses`, `metafields`)
  writing the **same** `$app:discount-<type>.config` contract. The function cannot tell the two paths
  apart — it only ever reads the metafield.

---

## Per-function config contracts

> **Shared contract with E3.** Each function is the consumer; its paired E3 admin UI extension is the
> producer. The shapes below are derived **field-for-field from `buildConfigFromFormData` in
> `discount-ui/src/hooks/useExtensionData.js`** — i.e. the **actual metafield JSON the working app
> writes today**, which is **snake_case** (not the camelCase prototype model the earlier draft cited).
> All product references are stored as **arrays of numeric IDs** (the numeric tail of the Shopify
> GID). The `*_full` arrays (e.g. `targets_full`, `source_variants_full`) carry `{productId,
> variantId?}` for the UI's picker re-hydration only and are **ignored by the function**. Numeric
> fields arrive as JSON numbers; booleans as JSON booleans. `serde` deserializes with
> `#[serde(default)]` and ignores unknown fields (forward-compatible). A `null`/absent config, or a
> value that exceeds the **10,000-byte** cap (returned to the function as `null`), means **emit no
> operations** — fail safe, never panic.

### Common / root fields

All three configs may carry a `rule_type` (`"tier-discount"` | `"bundle-discount"` |
`"special_discount"`) and a `platform` (`"BOTH"` | `"POS"` | `"CHECKOUT"`). The function **ignores
`rule_type`** (it is its own type) and honours `platform` at runtime.

Shop-level discount-code config lives in the **shop** metafield `checkout:priority_codes`, a JSON
**array** of `{ "code": string, "selector": "prefix" | "suffix" | "exact" }`. Matching is: `prefix`
→ cart code `starts_with` code; `suffix` → `ends_with`; `exact` (default) → equality.

```rust
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Selector { Prefix, Suffix, Exact }

#[derive(Deserialize)]
struct PriorityCode { code: String, #[serde(default)] selector: Option<Selector> } // default → Exact

// current run platform, from cart.attribute(key:"platform_source").value == "POS" ? POS : CHECKOUT
enum Platform { Both, Pos, Checkout }
```

### Tier — `$app:discount-tier.config`

`discount_tiers` is a **keyed object**, not an array: the key is the tier's discount magnitude (a
stringified number, e.g. `"20"`), and the value carries that tier's targets + optional per-line
`min_qty`. `discount_type` (`percentage`|`percent`|`amount`) and `apply_to` (`price`|
`compare_at_price`) and `product_discount_selection_strategy` (`ALL`|`FIRST`|`MAXIMUM`) live at root.

```jsonc
{
  "rule_type": "tier-discount",
  "discount_code_match_type": "…",          // optional, informational
  "message": "FLASH SALE",                  // optional prefix; final label is "{message} {tierKey}% OFF"
  "apply_to": "price" | "compare_at_price",
  "discount_type": "percentage" | "percent" | "amount",
  "product_discount_selection_strategy": "ALL" | "FIRST" | "MAXIMUM",
  "platform": "BOTH" | "POS" | "CHECKOUT",
  "discount_tiers": {
    "20": {                                 // key = discount value (also used as the magnitude)
      "product_selector_type": "variant_id" | "product_id",
      "targets": [111, 222],                // numeric variant OR product IDs
      "targets_full": [ { "variantId": "111" }, … ],   // UI-only, ignored by function
      "min_qty": 2                          // optional; PER-LINE threshold (line.quantity >= min_qty)
    }
  }
}
```

```rust
#[derive(Deserialize, Default)]
struct TierConfig {
    #[serde(default)] message: Option<String>,
    #[serde(default = "price")] apply_to: ApplyTo,
    #[serde(default)] discount_type: DiscountType,             // percentage | percent | amount
    #[serde(default, rename = "product_discount_selection_strategy")]
    selection_strategy: SelectionStrategy,                     // default ALL
    #[serde(default)] platform: Option<PlatformCfg>,           // default BOTH
    #[serde(default)] discount_tiers: BTreeMap<String, TierEntry>,
}
#[derive(Deserialize, Default)]
struct TierEntry {
    #[serde(default)] product_selector_type: SelectorType,     // default product_id
    #[serde(default)] targets: Vec<i64>,
    #[serde(default)] min_qty: Option<u32>,
}
```

### Bundle — `$app:discount-bundle.config`

`bundle_discounts` is an **array**; per-bundle `operator`/`value`/`message`/`apply_to`, per-bundle
`product_discount_selection_strategy`, and the entitlement controls. IDs live in `source_variants`/
`target_variants` (variant selector) **or** `source_product_ids`/`target_product_ids` (product
selector). Optional keys are omitted by the serializer when not applicable (`target_per_source` and
`shared_pool` only present when `quantity_dependent`; `max_target_qty` only when `fixed_ratios` and
provided; `min_qty` only when > 0).

```jsonc
{
  "rule_type": "bundle-discount",
  "platform": "BOTH" | "POS" | "CHECKOUT",
  "bundle_discounts": [
    {
      "source_selector_type": "variant_id" | "product_id",
      "target_selector_type": "variant_id" | "product_id",
      "source_variants": [111], "target_variants": [222],       // when *_selector_type = variant_id
      "source_product_ids": [10], "target_product_ids": [20],   // when *_selector_type = product_id
      "operator": "percentage" | "percent" | "amount",
      "value": 20,
      "message": "Buy 2 Get 1",                                 // REQUIRED (E3-validated non-empty)
      "apply_on": "target",                                     // constant, informational
      "apply_to": "price" | "compare_at_price",
      "product_discount_selection_strategy": "ALL" | "FIRST" | "MAXIMUM",
      "quantity_dependent": true,
      "target_per_source": 2,                                   // present only if quantity_dependent
      "fixed_ratios": false,                                    // note plural key
      "max_target_qty": 4,                                      // present only if fixed_ratios && provided
      "shared_pool": true,                                      // present only if quantity_dependent
      "min_qty": 2                                              // present only if > 0
    }
  ]
}
```

```rust
#[derive(Deserialize, Default)]
struct BundleConfig {
    #[serde(default)] platform: Option<PlatformCfg>,
    #[serde(default)] bundle_discounts: Vec<BundleRule>,
}
#[derive(Deserialize, Default)]
struct BundleRule {
    #[serde(default)] source_selector_type: SelectorType,      // default variant_id
    #[serde(default)] target_selector_type: SelectorType,      // default variant_id
    #[serde(default)] source_variants: Vec<i64>,
    #[serde(default)] target_variants: Vec<i64>,
    #[serde(default)] source_product_ids: Vec<i64>,
    #[serde(default)] target_product_ids: Vec<i64>,
    #[serde(default)] operator: Operator,                       // default percentage
    #[serde(default)] value: f64,
    #[serde(default)] message: String,
    #[serde(default)] apply_to: Option<ApplyTo>,
    #[serde(default, rename = "product_discount_selection_strategy")]
    selection_strategy: Option<SelectionStrategy>,
    #[serde(default)] quantity_dependent: bool,
    #[serde(default)] target_per_source: Option<u32>,
    // accept fixed_ratios / fixed_ratio / fixedRatio aliases (see Engine semantics)
    #[serde(default, alias = "fixed_ratio", alias = "fixedRatio")] fixed_ratios: bool,
    #[serde(default)] max_target_qty: Option<u32>,
    #[serde(default = "true")] shared_pool: bool,               // absent → true
    #[serde(default)] min_qty: Option<u32>,
    #[serde(default)] platform: Option<PlatformCfg>,            // per-bundle override
}
```

### Special — `$app:discount-special.config`

`special_discounts` is an **array**; each entry has its **own** source discount
(`source_operator`/`source_value`/`source_message`) **and** an array of independently-priced target
groups (`targets[]`, each with its own `target_operator`/`target_value`/`target_message`). The
entitlement controls (`quantity_dependent`, `target_per_source`, `fixed_ratios`, `shared_pool`,
`min_qty`) are per-special and shared across all target groups. **Special has no `max_target_qty`.**
`product_discount_selection_strategy` selects among **target groups** (source is always included).

```jsonc
{
  "rule_type": "special_discount",
  "platform": "BOTH" | "POS" | "CHECKOUT",
  "special_discounts": [
    {
      "source_selector_type": "variant_id" | "product_id",
      "source_variants": [111], "source_product_ids": [10],
      "source_operator": "percentage" | "amount",
      "source_value": 20,
      "source_message": "Main Item Deal",
      "targets": [
        {
          "target_selector_type": "variant_id" | "product_id",
          "target_variants": [222], "target_product_ids": [20],
          "target_operator": "percentage" | "amount",
          "target_value": 30,
          "target_message": "Bonus Item"
        }
      ],
      "message": "…",                                           // REQUIRED (E3-validated non-empty)
      "apply_on": "target",                                     // constant, informational
      "apply_to": "price" | "compare_at_price",
      "product_discount_selection_strategy": "ALL" | "FIRST" | "MAXIMUM",
      "quantity_dependent": true,
      "target_per_source": 1,                                   // present only if quantity_dependent
      "fixed_ratios": false,
      "shared_pool": true,                                      // present only if quantity_dependent
      "min_qty": 2                                              // present only if > 0
    }
  ]
}
```

```rust
#[derive(Deserialize, Default)]
struct SpecialConfig {
    #[serde(default)] platform: Option<PlatformCfg>,
    #[serde(default)] special_discounts: Vec<SpecialRule>,
}
#[derive(Deserialize, Default)]
struct SpecialRule {
    #[serde(default)] source_selector_type: SelectorType,      // default variant_id
    #[serde(default)] source_variants: Vec<i64>,
    #[serde(default)] source_product_ids: Vec<i64>,
    #[serde(default)] source_operator: Option<Operator>,       // default → `operator` → percentage
    #[serde(default)] source_value: f64,
    #[serde(default)] source_message: String,
    #[serde(default)] operator: Operator,                      // group fallback, default percentage
    #[serde(default)] targets: Vec<SpecialTarget>,
    #[serde(default)] message: String,
    #[serde(default)] apply_to: Option<ApplyTo>,
    #[serde(default, rename = "product_discount_selection_strategy")]
    selection_strategy: SelectionStrategy,                     // default ALL (over target GROUPS)
    #[serde(default)] quantity_dependent: bool,
    #[serde(default)] target_per_source: Option<u32>,
    #[serde(default, alias = "fixed_ratio", alias = "fixedRatio")] fixed_ratios: bool,
    #[serde(default = "true")] shared_pool: bool,
    #[serde(default)] min_qty: Option<u32>,
    #[serde(default)] platform: Option<PlatformCfg>,
}
#[derive(Deserialize, Default)]
struct SpecialTarget {
    #[serde(default)] target_selector_type: SelectorType,      // default variant_id
    #[serde(default)] target_variants: Vec<i64>,
    #[serde(default)] target_product_ids: Vec<i64>,
    #[serde(default)] target_operator: Option<Operator>,       // default → rule.operator
    #[serde(default)] target_value: f64,
    #[serde(default)] target_message: String,
}
```

> `_normalizeTargets` in the JS also accepts a **legacy flattened** single-target form
> (`target_selector_type`/`target_variants`/`target_operator`/… directly on the special, no
> `targets[]`). The Rust port must reproduce this: if `targets` is empty but a top-level target field
> is present, synthesize a one-element `targets` vec from those fields.

### Discount value / operation shape (all three)

The emitted operation is always a single `productDiscountsAdd { candidates, selectionStrategy }`.
Each candidate is `{ message, targets: [{ cartLine: { id } }], value }` where `value` is either
`{ percentage: { value } }` or `{ fixedAmount: { amount } }` (with `appliesToEachItem: false` for the
partial-quantity / compare-at cases). `selectionStrategy` maps to the API enum `ALL`/`FIRST`/
`MAXIMUM`.

### Producer-side validation (E3, not re-run by the function)

Mirrors `validateTierConfig`/`validateBundleConfig`/`validateSpecialConfig`. The function does **not**
re-validate but must fail safe if violated:
- **Tier:** each tier has a non-empty `value` and ≥ 1 target; `discount_type` + `platform` present.
- **Bundle:** ≥ 1 source, ≥ 1 target, `operator`, non-empty `value`, non-empty `message`; if
  `fixed_ratios` and `max_target_qty` provided → `max_target_qty > target_per_source` and
  `> min_qty`.
- **Special:** ≥ 1 source, ≥ 1 target group each with ≥ 1 product, non-empty `message`.

---

## Engine semantics

Behaviours below are ported **exactly** from the JS. Shared plumbing (`shared.rs`) reproduces the
coordinator utilities from `shopify-discount-applier.js`.

### Shared (all three)

- **ID extraction.** `id_from_gid` = numeric tail of `gid://shopify/…/<id>`. Variant id from
  `merchandise.id`; product id from `merchandise.product.id`. Config stores these numeric IDs.
- **Line matching (`line_matches_targets`).** `variant_id` selector → line's variant id ∈ target set.
  `product_id` selector → line's product id ∈ set, **falling back** to variant id ∈ set.
- **Quantity sums.** `calculateTotalQuantityForVariants` / `…ForProducts` sum `line.quantity` over
  matching lines.
- **`apply_to`.** `price` → `cost.amountPerQuantity.amount`; `compare_at_price` →
  `cost.compareAtAmountPerQuantity.amount`. When compare-at is null/empty/0, **fall back to selling
  price** (never error the cart). A candidate is **skipped** only when `compareAtPrice < currentPrice`
  (invalid compare-at). `-`/case are normalized (`compare-at-price` → `compare_at_price`).
- **Platform.** `current_platform` = `POS` if `cart.attribute(key:"platform_source").value` upper ==
  `"POS"`, else `CHECKOUT`. A rule is allowed when its `platform` is `BOTH` or equals
  `current_platform`; otherwise it emits **no** operation. (Bundle and special also read a per-rule
  `platform`, falling back to the root platform.)
- **Discount-code yield (`should_yield_to_discount_code`).** If `triggeringDiscountCode` is set
  (code-triggered run) → **never yield** (returning empty would surface a "not applicable" error). If
  automatic (`triggeringDiscountCode` null/empty) and `cart.discountCode.value` matches any
  `checkout:priority_codes` entry (by `prefix`/`suffix`/`exact`) → **yield** (return empty
  operations), letting the code discount take precedence. This check runs **before** the engine for
  every function.
- **Operation builder.** Wrap candidates in `productDiscountsAdd { candidates, selectionStrategy }`;
  strategy enum defaults to `ALL` when unmapped.
- **Empty / null / oversized config → return empty operations.** The delivery target always returns
  empty operations.

### Tier (ported from `tier_discount.js`)

- `isPercentageDiscount` = `discount_type ∈ {percentage, percent}`; else `amount` →
  `fixedAmount`.
- **Iterate over every tier key** in `discount_tiers` (`Object.keys(...)`), building candidates for
  each — there is **no "best tier wins" selection**. Each tier is independent: its `targets` +
  per-line `min_qty` + the tier key as the discount magnitude. (This corrects the earlier draft,
  which wrongly claimed graduated best-tier selection.)
- **`min_qty` is PER-LINE**, not a total: a line is eligible only if `line.quantity >= min_qty`.
  Lines below threshold get nothing.
- **Selection strategy** (root `product_discount_selection_strategy`, applied within each tier's
  eligible lines): `ALL` → every eligible line; `FIRST` → the first eligible line (cart order);
  `MAXIMUM` → the single line with the largest `subtotal * (tierKey/100)` (largest resulting
  discount). Confirmed by `_buildMaximumTarget`.
- **Message** = `"{message} {tierKey}% OFF"` when a root `message` is set, else `"{tierKey}% OFF"`.
- **`price` path** → one candidate per strategy result with `value = { percentage | fixedAmount }`.
- **`compare_at_price` path** → per-line `fixedAmount` computed so the final price equals
  `compareAt * (1 - tierKey/100)` (percentage) or `min(tierKey, currentPrice)` (amount); total =
  `round(perItem * line.quantity)`; skip line when `compareAt < currentPrice`.
- Returns a single `productDiscountsAdd` over all tiers' candidates.

### Bundle (ported from `bundle_discount.js`)

For **each** entry in `bundle_discounts` (per-bundle platform-gated):

1. **Selector + IDs.** Resolve `source_selector_type`/`target_selector_type` (default `variant_id`),
   read `source_variants|source_product_ids` and `target_variants|target_product_ids` accordingly.
2. **Presence.** `cartHasBothSourceAndTarget` — cart must contain ≥ 1 source **and** ≥ 1 target line;
   else skip.
3. **Target min-qty gate.** `_meetsBundleMinQuantityRequirement` — total **target** qty (across all
   target lines) ≥ `min_qty`.
4. **Source min-qty gate (OR logic).** `_meetsSourceMinimumQuantityRequirement` — at least **one**
   single source line has `quantity >= min_qty`. (Not a sum — OR across source lines.)
5. **Entitlement (`_resolveMaxDiscountQty`).**
   - `quantity_dependent = false` → `maxDiscountQty = ∞` (all matched targets discounted); ratio
     fields ignored.
   - `target_per_source` (tps) resolved as `max(1, parseInt)`. `sourcePool = floor(sourceQty /
     min_qty) * tps` (or `sourceQty * tps` when `min_qty` is 0).
   - `fixed_ratios = false` → `maxDiscountQty = sourcePool` (`max_target_qty` ignored; partial target
     sets are fine).
   - `fixed_ratios = true`:
     - `targetExact = floor(totalTargetQty / tps) * tps` (target qty floored to whole sets).
     - **`max_target_qty` provided** (positive) → validate `max_target_qty > min_qty` **and** `>` the
       resolved tps (fail → skip, `maxDiscountQty = 0`). Then it is a **per-source** cap:
       `completeSets = floor(sourceQty / min_qty)` (or `sourceQty` if `min_qty` 0);
       `effectiveCap = max_target_qty * max(1, completeSets)`; `maxDiscountQty = min(effectiveCap,
       targetExact)`.
     - **`max_target_qty` absent** → `maxDiscountQty = min(sourcePool, targetExact)`.
   - Accept `fixed_ratios` / `fixed_ratio` / `fixedRatio` as aliases.
   - If quantity-limited and `maxDiscountQty == 0` → **skip the whole bundle** (no message, no 0%
     candidates).
6. **Shared pool.** `shared_pool` absent/`true` → `perLineCap = false` (one budget drained across all
   target lines). `shared_pool = false` → `perLineCap = true` (each target line independently gets up
   to `maxDiscountQty`).
7. **Candidates.**
   - **Source lines** → **message-only** candidates (value `{ percentage: { value: 0 } }`) — the
     discount is shown on source but not applied there.
   - **Target lines** → apply `operator`/`value` off `apply_to`, consuming the pool. Full-quantity
     lines emit `{ percentage }` (or `{ fixedAmount }` for amount); partially-covered lines emit a
     computed `fixedAmount` for `qtyToDiscount` items (`appliesToEachItem: false`); lines past the
     pool emit a 0% candidate. The `compare_at_price` variant computes `fixedAmount` from compare-at
     with the same pool draining.
8. **Combine.** All candidates from **all** bundles are merged into a **single** `productDiscountsAdd`
   (Shopify allows one such op), using the **first** bundle's
   `product_discount_selection_strategy` (fallback root/`ALL`).

### Special (ported from `special_discount.js`)

For **each** entry in `special_discounts` (per-special platform-gated):

1. **Source selector + IDs**; **`_normalizeTargets`** (array form or synthesized legacy single
   target). Skip if no targets.
2. **Presence.** `_cartHasSourceAndAnyTarget` — cart must contain source **and** at least one target
   group's item.
3. **Source min-qty gate (OR logic)** — same as bundle.
4. **Shared pool (`_resolveSharedPool`).** Same source-pool formula as bundle. For `fixed_ratios =
   true`, `totalTargetQty` is summed **across all target groups**, floored to `targetExact = floor(/
   tps) * tps`, and `sharedPool = min(sourcePool, targetExact)`. **No `max_target_qty` in special.**
   `quantity_dependent = false` → `sharedPool = ∞`.
5. **Source candidates.** Built with `source_operator`/`source_value`/`source_message`,
   **never quantity-dependent**, and **always included** (they bypass the selection strategy). Built
   before target groups so a `fixed_ratios` pool of 0 correctly yields no source discount either
   (empty result).
6. **Target groups.** Iterate groups in config order, each drawing from the **shared pool**:
   - `availableForGroup = remainingPool` (when quantity-dependent). If ≤ 0 → group produces nothing.
   - Each group applies its own `target_operator`/`target_value`/`target_message` off `apply_to`.
   - `shared_pool = false` → `perLineCap = true` within the group; else shared. After building a
     group, `remainingPool -= _countDiscountedQty(group)` (count of actually-discounted units).
7. **Selection strategy over GROUPS** (`_applySelectionStrategy`): `ALL` → all non-empty groups
   flattened; `FIRST` → the first non-empty group only; `MAXIMUM` → the group with the highest total
   magnitude (sum of `fixedAmount.amount` or `percentage.value` across its candidates). Source
   candidates are **not** subject to this.
8. **Combine.** One `productDiscountsAdd` over `[...sourceCandidates, ...filteredTargetCandidates]`
   (no strategy override — builder default).

### Class routing, order/shipping, combinesWith

- `cart.lines.discounts.generate.run` emits `PRODUCT` (and `ORDER` if a future rule targets the whole
  order); `cart.delivery-options.discounts.generate.run` emits `SHIPPING`. Each target only emits
  classes granted via `discountClasses`; otherwise Shopify rejects the op.
- None of tier/bundle/special emit order/shipping today — the delivery target is a plumbed **no-op**
  (empty-safe) so future rule types slot in without re-architecting.
- `combinesWith` (product/order/shipping) is declared at **creation** (E3 / programmatic) and passed
  through; the function does not decide cross-discount stacking — Shopify's default allocator handles
  allocation (the Plus-only Discounts Allocator is out of scope).

---

## Issue breakdown

### E2-1 — Rust function workspace + scaffold all three extensions

- **What.** Create `extensions/discount-tier/`, `extensions/discount-bundle/`,
  `extensions/discount-special/`, each a standalone Rust `shopify_function` extension registered in
  `shopify.app.toml`. Each exports both run targets. **Un-share** identity: distinct `handle`,
  freshly generated `uid`, `[extensions.ui] handle = "discount-<type>-ui"`, and re-pin
  `api_version = "2026-01"`. Establish shared input-query and config-parse conventions (`shared.rs`
  duplicated per extension for now). Wire Cargo build → `dist/function.wasm` and the
  `function-runner` / `shopify app function run` tooling.
- **Acceptance criteria.**
  - `shopify app build` compiles all three functions to Wasm; each declares both targets and a
    **distinct** handle + uid + ui-handle + metafield namespace.
  - Empty / `null` / oversized config → both targets return empty operations (no panic).
  - Input query is lean enough that a 200-line cart fixture stays under the 128 kB input limit.
- **Files touched.** `extensions/discount-{tier,bundle,special}/shopify.extension.toml`,
  `.../Cargo.toml`, `.../src/main.rs`, `.../src/cart_lines_run.rs`, `.../src/delivery_run.rs`,
  `.../src/cart_lines_run.graphql`, `.../src/delivery_run.graphql`, `.../src/shared.rs`.

### E2-2 — `discount-tier` (Rust) — port `tier_discount.js`

- **What.** Implement the tier engine: iterate every `discount_tiers` key, per-line `min_qty`
  filter, per-tier candidate build, root `product_discount_selection_strategy` (ALL/FIRST/MAXIMUM),
  `percentage`/`amount`, `price` vs `compare_at_price` (with selling-price fallback and
  `compareAt < price` skip). Message `"{message} {tierKey}% OFF"`.
- **Acceptance criteria.**
  - Below-threshold line (per-line `min_qty`) → no discount; at/above → discounted.
  - Every tier key independently produces candidates (no best-tier collapse).
  - `variant_id` vs `product_id` matching both covered; `percentage` and `amount` both correct;
    `compare_at_price` computes the right `fixedAmount` and falls back when compare-at absent.
  - `FIRST`/`MAXIMUM`/`ALL` select the correct line(s).
- **Files touched.** `extensions/discount-tier/src/{engine.rs,config.rs,cart_lines_run.rs}`.

### E2-3 — `discount-bundle` (Rust) — port `bundle_discount.js`

- **What.** Implement the bundle engine: presence check, target-total and source-OR min-qty gates,
  the full `_resolveMaxDiscountQty` entitlement math (`quantity_dependent`, `target_per_source`,
  `fixed_ratios` + `max_target_qty` per-source cap + validation, `sourcePool`/`targetExact`),
  `shared_pool` (shared vs per-line cap), message-only source candidates + discounted target
  candidates (standard + compare-at), single merged `productDiscountsAdd` using the first bundle's
  strategy.
- **Acceptance criteria.**
  - buy-1-get-1 and buy-1-get-2 (`target_per_source`) produce the right discounted qty.
  - `fixed_ratios` discounts only whole sets; `max_target_qty` caps per-source and is validated
    (skip on invalid); pool-0 skips the whole bundle.
  - `shared_pool` true vs false split entitlement across target lines correctly.
  - `quantity_dependent = false` applies without ratio gating; source lines get message-only 0%
    candidates.
  - `ALL`/`FIRST`/`MAXIMUM` select correctly; source==target overlap does not double-count.
- **Files touched.** `extensions/discount-bundle/src/{engine.rs,entitlement.rs,config.rs,cart_lines_run.rs}`.

### E2-4 — `discount-special` (Rust) — port `special_discount.js`

- **What.** Implement the special engine: `_normalizeTargets` (array + legacy single), presence,
  source-OR min-qty, `_resolveSharedPool` (cross-group `fixed_ratios` target count, no
  `max_target_qty`), always-included non-quantity-dependent source candidates, per-group pool
  draining with `_countDiscountedQty`, `shared_pool` per-line cap, per-GROUP selection strategy
  (ALL/FIRST/MAXIMUM by magnitude), single merged operation.
- **Acceptance criteria.**
  - Source items receive `source_operator`/`source_value`; each `targets[]` group its own
    operator/value/message.
  - Multiple target groups each emit distinct candidates; per-group strategy filters correctly.
  - `shared_pool` shares/splits entitlement across lines within a group; pool drains across groups.
  - `fixed_ratios` counts target qty across all groups; compare-at fallback works; legacy
    single-target form parses.
- **Files touched.** `extensions/discount-special/src/{engine.rs,config.rs,cart_lines_run.rs}` (may
  reuse an entitlement helper mirroring E2-3).

### E2-5 — Per-function config serde structs + code matching + distinct metafield keys

- **What.** Define the serde structs in *Per-function config contracts* per extension, each reading
  **only its own** `$app:discount-<type>.config` metafield in its input query. Implement the shop
  `checkout:priority_codes` read + `should_yield_to_discount_code` (prefix/suffix/exact, automatic-vs
  -code-triggered rules). Ensure `#[serde(default)]` + ignore-unknown so `rule_type`/`*_full`/extra
  fields are tolerated.
- **Acceptance criteria.**
  - Each function round-trips every field of its type from the actual `buildConfigFromFormData`
    output (snake_case, numeric ID arrays, keyed `discount_tiers`).
  - `checkout:priority_codes` matching: prefix/suffix/exact all correct; code-triggered run never
    yields; automatic run with a matching cart code yields (empty ops).
  - Distinct namespaces verified: tier reads `$app:discount-tier`, bundle `$app:discount-bundle`,
    special `$app:discount-special`; none read `$app:discount-engine`.
  - Unknown/extra fields ignored; missing optionals default (`max_target_qty` → none, `shared_pool`
    → true, strategy → ALL, selector → per-type default).
- **Files touched.** `extensions/discount-{tier,bundle,special}/src/config.rs`, `.../src/shared.rs`
  (code matching), `.../src/cart_lines_run.graphql` (metafield + shop selection), contract doc
  comment in each `config.rs`.

### E2-6 — Shared per-function concerns: platform, `discountClasses`, `combinesWith`, delivery no-op

- **What.** Per function, implement platform gating (`BOTH`/`POS`/`CHECKOUT` from the
  `platform_source` cart attribute; per-rule override for bundle/special), gate emitted operations by
  granted `discountClasses`, wire the delivery target as an empty-safe no-op, and pass through
  `combinesWith` (declared at creation) without custom allocation.
- **Acceptance criteria.**
  - A discount granted only `PRODUCT` never emits `ORDER`/`SHIPPING` (no rejection).
  - Delivery target returns empty operations for all three functions.
  - Platform gating resolves per run context (POS-only rule in a POS context applies; in checkout it
    does not, and vice versa).
- **Files touched.** `extensions/discount-{tier,bundle,special}/src/{cart_lines_run.rs,delivery_run.rs,shared.rs}`.

### E2-7 — Rust test suite (function-runner fixtures, per function)

- **What.** Author `function-runner` input fixtures + expected outputs for each of the three
  functions and their edge cases; wire into `cargo test` / `shopify app function run` and CI. Port
  fixtures from `eva/discount-engine/local/payload/*` and the worked examples in
  `eva/discount-engine/docs/{tier-discount,bundle-discount,special-discount}.md`.
- **Acceptance criteria.**
  - Green fixtures for tier, bundle, special covering the E2-2/3/4 criteria.
  - Edge fixtures (empty cart, 200-line cart, > 10 KB metafield → null, platform mismatch, code
    yield) pass; output stays under the 20 kB limit.
  - Parity fixtures assert the Rust output matches the JS handler output on the same input.
- **Files touched.** `extensions/discount-{tier,bundle,special}/tests/*.rs`,
  `.../tests/fixtures/**/*.json`.

---

## Testing

Run via `function-runner` (`shopify app function run`) with JSON input fixtures and asserted output
operations, **one fixtures tree per extension** (`discount-tier/tests`, `discount-bundle/tests`,
`discount-special/tests`) plus a shared edge set per function. Fixtures are ported from
`eva/discount-engine/local/payload/{payload1,payload2}.js` and the documented examples in
`eva/discount-engine/docs/*.md`.

**Tier fixtures**
- Below per-line `min_qty` (no discount) vs at/above; multiple tier keys each firing independently;
  `variant_id` vs `product_id`; `percentage` vs `amount`; `compare_at_price` with and without a
  compare-at value; each selection strategy (`ALL`/`FIRST`/`MAXIMUM`).

**Bundle fixtures**
- buy-1-get-1; buy-1-get-2 via `target_per_source`; `fixed_ratios` partial-set (no discount) vs
  complete-set; `max_target_qty` per-source cap (1 source → cap N, 2 sources → cap 2N) + validation
  failures (≤ tps, ≤ min_qty → skip); `shared_pool` true vs false across two target products;
  `quantity_dependent = false`; source-OR min-qty; source==target overlap; each selection strategy;
  the message-only source candidate.

**Special fixtures**
- Source-only; source + single target group; source + multiple groups each with distinct
  operator/value/message; per-group `shared_pool` and cross-group pool draining; `fixed_ratios`
  counting target qty across all groups; per-group selection strategy `ALL`/`FIRST`/`MAXIMUM`; legacy
  flattened single-target form; compare-at fallback.

**Edge cases (all functions)**
- Empty cart → empty operations.
- 200-line cart → input < 128 kB, output < 20 kB (strategy bounds output size, esp. `ALL`).
- Metafield > 10 KB → returned `null` → no operations, no panic.
- Malformed / missing fields → serde defaults + ignore-unknown, no panic.
- Missing compare-at with `apply_to = compare_at_price` → selling-price fallback.
- Platform mismatch → no operation.
- Discount-code yield: automatic run + matching `checkout:priority_codes` → empty; code-triggered run
  → never yields.

**Parity tests.** For a shared corpus of inputs, assert the Rust function output equals the JS
handler output (run the JS handler once to snapshot expected operations, then assert the Rust port
reproduces them). This is the primary guard against JS→Rust behaviour drift.

CI gate: `cargo test` + `cargo clippy` + `shopify app build` for all three extensions; all fixtures
asserted.

---

## Risks / open questions

- **25-active-function cap with three functions (+ cart transform).** The split turns one function
  slot into up to three (tier + bundle + special) plus the E6 cart transform — a merchant using all
  four discount types has four registered functions and consumes four of their 25 slots per store.
  E11 must reconcile active count against `min(shopifyCap=25, appTierCap)`. Flagged so E2/E11
  assumptions stay consistent; no function-side enforcement.
- **JS → Rust behaviour parity.** The handlers carry subtle, hard-won behaviour: per-line tier
  `min_qty`, source-qty **OR** logic, the `fixed_ratios` + per-source `max_target_qty` cap, shared
  pool draining, message-only source candidates, per-target-group selection strategy, and rounding
  (`round(perItem * qty * 100) / 100`). The parity test corpus (E2-7) is the mitigation — freeze it
  before the ports land. Note the earlier draft's "deepest satisfied tier wins" claim was **wrong**;
  the actual tier handler fires every configured tier independently.
- **Shared crate vs full independence.** Master §1a fixed "3 fully independent extensions", so the
  default is duplicating `shared.rs` per extension. A thin shared crate for cart-input plumbing
  (GID parsing, matching, qty sums, operation builder, code-yield) is **optional and deferred** — it
  reduces drift but reintroduces a coupling point across the three functions. **Open question:**
  extract a `discount-shared` crate after the three ports stabilize, or keep them fully independent?
  Not decided in E2.
- **Un-sharing uid / handle / metafield key.** The worktrees reuse one `uid`, one `handle`, one
  `[extensions.ui]` handle, and one `$app:discount-engine` namespace. Each must become distinct
  (three new uids, three handles, three ui-handles, three `$app:discount-<type>` namespaces). Any
  existing metafield definitions written under `$app:discount-engine` are **not** read by the new
  functions — E3/E4 own any migration of previously-authored configs (out of scope for E2, but the
  contract change is noted here).
- **api_version alignment.** The live monolith is `2026-01`; the worktrees are pinned to the older
  `2025-04`. All three new extensions must pin `2026-01` to match the unified Discount Function API
  the input query and `discountClasses` model rely on. Confirm the `platform_source` cart attribute
  and `triggeringDiscountCode` are both available under `2026-01` in **both** run targets; if POS
  context is not resolvable at runtime, platform gating may need to move to discount registration
  (E3) rather than function runtime.
- **`compare_at_price` fallback + `MAXIMUM` definition.** Preserved from the JS: degrade to selling
  price when compare-at is absent (rather than emitting no discount), and `MAXIMUM` = largest
  resulting discount amount (`subtotal * pct` for tier; summed candidate magnitude for special
  groups). Flag both for product sign-off before fixtures freeze.
- **10 KB budget realism.** Configs enumerating many variant/product IDs can approach the cap. E3's
  serializer already strips `*_full` display fields. If real catalogs still overflow, an open
  question (shared with E3) is whether to reference collections/product IDs instead of enumerating
  variants — out of scope for E2 but affects the shared contract.
