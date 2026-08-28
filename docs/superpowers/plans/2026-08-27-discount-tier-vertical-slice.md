# Discount Tier Vertical Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `discount-tier` discount type end-to-end — a Rust Shopify Function (ported from `eva/discount-engine`'s `tier_discount.js`) plus its Preact admin-UI extension (`discount-tier-ui`) — inside the existing `discount-jet` Cloudflare app, proven by JS→Rust parity tests and a manual dev-store round-trip.

**Architecture:** This is the first **vertical slice** of E2 + E3. The existing Cloudflare Worker / Hono / D1 / React app is untouched; we layer the Shopify-CLI extension toolchain on top (a "minimal E1" bootstrap), then build one discount type all the way through. The Rust function reads `$app:discount-tier.config` from the discount metafield and emits a single `productDiscountsAdd` operation; the admin UI extension writes that same metafield via `shopify.applyMetafieldChange`. Bundle and special replicate this exact task template in follow-up plans once the pattern is proven.

**Tech Stack:** Rust (`shopify_function` crate 2.x, `serde`/`serde_json`, compiled to `wasm32` by the Shopify CLI); Preact 10 + `@shopify/ui-extensions` 2025.10 (Polaris `s-*` web components); Shopify CLI (`@shopify/cli`, `@shopify/app`); Unified Discount Function API `2026-01`; admin UI extension api_version `2025-10`. Existing app: Cloudflare Workers + Hono + Drizzle/D1 + React 18/Polaris + `@shopify/shopify-api` (untouched).

**Spec:**
- `docs/superpowers/specs/2026-08-25-e02-discount-function-design.md` (E2 — Rust functions)
- `docs/superpowers/specs/2026-08-25-e03-discount-authoring-design.md` (E3 — admin UI extensions)
- `docs/superpowers/specs/2026-08-25-discount-jet-decomposition.md` (master; §1a decisions, §4 API facts, §5 conventions)

**Port source:** `/Users/hassanahmed/code/eva/discount-engine` (external repo, read-only reference).

## Global Constraints

- **All IDs are `crypto.randomUUID()`**; timestamps are ISO 8601 `text()` strings (project CLAUDE.md). N/A to this slice (no D1 tables added) but binds any future task here.
- **Secure routes by default** — this slice adds **no** `/api/*` route. If one proves unavoidable it must be `requireShop`-guarded with a justified `PUBLIC_API_PATHS` entry (project CLAUDE.md §Code Quality).
- **Fail loudly on data-integrity issues** — no `?? ''` masking of missing required fields (project CLAUDE.md). The metafield-definition create must throw on failure.
- **Function fail-safe** — a `null` / absent / oversized (>10,000-byte, returned as `null`) config, or any parse error, means **emit zero operations**; the function must never panic (E2 spec §Per-function config contracts).
- **Discount Function API version = `2026-01`** on the function extension; **admin UI api_version = `2025-10`** (E2/E3 specs). Re-pin from the eva worktrees' stale `2025-04`.
- **Un-share identity** — the tier extension uses `handle = "discount-tier"`, a **freshly generated** `uid`, `[extensions.ui] handle = "discount-tier-ui"`, and metafield namespace `$app:discount-tier` / key `config`. It must NOT reuse the monolith's `discount-function` handle, its `630829f6-…` uid, or the `$app:discount-engine` namespace (E2 spec §"un-sharing requirement").
- **Metafield size cap** = `10 * 1024` bytes, measured on the serialized minimized value; warn at 80 % (8 192 B), block save at 100 % (10 240 B) (E3 spec §"10 KB size meter").
- **Behaviour-faithful port** — the Rust output must match the JS handler's output on a shared fixture corpus; JS→Rust parity fixtures are the gate (E2 spec §Testing).
- **Scopes match** — `shopify.app.toml` `[access_scopes] scopes` and `src/shopify.ts` scopes must both include `write_discounts` and `read_products`.

---

## Deviations from the specs (resolved defaults — confirm on review)

1. **No `useResourceDetails` / `SelectedResources` port (E3 §"Live resource hydration").** These files do **not exist** in the eva port source. The working app persists `targets_full` (full picker objects: `productId`/`variantId`/`productTitle`/`variantTitle`/`sku`) *alongside* numeric `targets` in the metafield and renders selection chips **inline** in `TierCard`. This plan matches that actual behaviour (behaviour-faithful override) and does **not** build the "persist IDs only + live re-fetch" abstraction. The Rust function ignores `targets_full` and reads only numeric `targets` (E2 spec already states `*_full` is UI-only, ignored by the function).
2. **`fixedAmount.amount` type is intentionally inconsistent across paths** (faithful to JS): the standard path emits it as a JSON **number**; the compare-at path emits it as a **string** (`round(x*100)/100` then stringified). Parity tests assert both.
3. **`rule_type` retained in the JSON** (harmless; the function ignores it via `#[serde(default)]` + ignore-unknown). E4's mirror can use it later.

---

## File Structure

**Bootstrap (Phase 0):**
- Create: `shopify.app.toml` (repo root) — Shopify CLI app config; `client_id`, scopes, `extension_directories`.
- Create: `extensions/` (directory; holds all extensions).
- Modify: `src/shopify.ts:8-15` — add `write_discounts` to scopes.
- Modify: `package.json` — add `@shopify/cli`, `@shopify/app` devDeps + `shopify` script.
- Create: `extensions/README.md` — note the two deploy paths (wrangler vs `shopify app deploy`).

**Tier function (Phase 1) — `extensions/discount-tier/`:**
- `shopify.extension.toml` — handle `discount-tier`, new uid, two targets, `[extensions.ui] handle = "discount-tier-ui"`, `[extensions.build] path = "dist/function.wasm"`.
- `Cargo.toml` — `shopify_function`, `serde`, `serde_json`.
- `src/main.rs` — declares both run targets, wires to modules.
- `src/config.rs` — serde structs for tier config (`TierConfig`, `TierEntry`, enums).
- `src/shared.rs` — gid parsing, line matching, subtotal, apply_to, platform, code-yield, operation builder.
- `src/engine.rs` — the ported tier algorithm (`build_candidates`).
- `src/cart_lines_run.graphql` — input query (reads `$app:discount-tier`/`config`).
- `src/delivery_run.graphql` — delivery input query.
- `tests/tier.rs` — Rust unit + parity tests.
- `tests/fixtures/*.json` — input + expected-output fixtures (ported from `eva/local/payload/*`).

**Tier UI (Phase 2) — `extensions/discount-tier-ui/` + `extensions/shared/`:**
- `extensions/discount-tier-ui/shopify.extension.toml` — type `ui_extension`, new uid/handle/name, target `admin.discount-details.function-settings.render`.
- `extensions/discount-tier-ui/package.json` — `preact`, `@shopify/ui-extensions`.
- `extensions/discount-tier-ui/src/DiscountTierSettings.jsx` — entry: ensure metafield definition → `render(<App/>)`.
- `extensions/discount-tier-ui/src/App.jsx` — tier-only form (no rule_type select).
- `extensions/shared/metafield.js` — parameterized `(namespace, key)` definition ensure/create + `parseMetafield`.
- `extensions/shared/hooks/useExtensionData.js` — single-type tier form-state, `buildConfigFromFormData`, `validateTierConfig`, size meter, `applyExtensionMetafieldChange`.
- `extensions/shared/components/TierCard.jsx` — ported tier card + inline chips + `shopify.resourcePicker`.
- `extensions/shared/components/ConfigurationPreview.jsx` — tier recap banner (ported).

---

## Phase 0 — Bootstrap the Shopify-CLI extension toolchain

### Task 0.1: Shopify app config + extensions dir + scope alignment

**Files:**
- Create: `shopify.app.toml`
- Create: `extensions/.gitkeep`, `extensions/README.md`
- Modify: `src/shopify.ts:8-15`
- Modify: `package.json` (devDependencies + scripts)

**Interfaces:**
- Produces: a working `shopify app` CLI context (`shopify.app.toml` at root) that every extension task relies on; the `extensions/` directory root; scope `write_discounts` present in both config surfaces.

- [ ] **Step 1: Create `shopify.app.toml`** at repo root. Reuse the existing app's `client_id` (from `.dev.vars`/env — the app already authenticates with `env.SHOPIFY_CLIENT_ID`; use that same client id here). Content:

```toml
# Shopify CLI app config — coexists with wrangler.jsonc.
# wrangler deploys the Worker; `shopify app deploy` deploys the extensions below.
client_id = "b505864aecb6665908d89dfceab0ef9e"
name = "discount-jet"
application_url = "https://discount-jet.example.workers.dev"
embedded = true

extension_directories = ["extensions/*"]

[build]
automatically_update_urls_on_dev = false

[webhooks]
api_version = "2026-01"

[access_scopes]
scopes = "write_discounts,read_products,read_orders"

[auth]
redirect_urls = [ "https://discount-jet.example.workers.dev/shopify/callback" ]
```

> Replace `application_url` / `redirect_urls` host with the real deployed Worker host if it differs. `client_id` MUST equal the value the Worker uses (`env.SHOPIFY_CLIENT_ID`); a mismatch breaks extension↔app linkage. If unknown, stop and confirm with the maintainer rather than guessing.

- [ ] **Step 2: Create the extensions directory.** Run:

```bash
mkdir -p extensions && touch extensions/.gitkeep
```

- [ ] **Step 3: Write `extensions/README.md`:**

```markdown
# Extensions

Shopify Functions and admin UI extensions, built/deployed via the Shopify CLI
(`shopify app dev` / `shopify app deploy`) — a path independent of the
Cloudflare Worker (`wrangler deploy`). The Worker hosts OAuth + the embedded
SPA; these extensions run on Shopify's platform.

- `discount-tier/`     — Rust discount function (product discounts by tier)
- `discount-tier-ui/`  — Preact admin UI extension (writes $app:discount-tier.config)
- `shared/`            — shared Preact components/hooks imported by the UI extensions
```

- [ ] **Step 4: Add `write_discounts` scope** to `src/shopify.ts`. Change the `scopes` array (currently `['read_products', 'read_orders']`) to:

```ts
    scopes: [
      'read_products',
      'read_orders',
      'write_discounts',
    ],
```

- [ ] **Step 5: Add Shopify CLI to `package.json`** devDependencies and a script. Run:

```bash
npm install --save-dev @shopify/cli @shopify/app
npm pkg set scripts.shopify="shopify"
```

- [ ] **Step 6: Verify the CLI recognizes the app config.**

Run: `npx shopify app info`
Expected: prints app `discount-jet`, the `client_id`, and an (empty) extensions list without error. If it prompts to log in, that's expected — the maintainer runs `! npx shopify auth login` in-session.

- [ ] **Step 7: Commit.**

```bash
git add shopify.app.toml extensions/.gitkeep extensions/README.md src/shopify.ts package.json package-lock.json
git commit -m "chore(extensions): bootstrap Shopify CLI app config + extensions dir + write_discounts scope"
```

### Task 0.2: Rust / wasm toolchain readiness

**Files:** none created (environment + verification only; the extension's `Cargo.toml` is created in Task 1.1).

**Interfaces:**
- Produces: a confirmed `cargo` + `wasm32` build environment so Phase 1 can compile to `dist/function.wasm`.

- [ ] **Step 1: Verify Rust + wasm target.**

Run:
```bash
rustc --version && cargo --version && rustup target list --installed | grep wasm32
```
Expected: rustc/cargo present; a `wasm32-*` target listed.

- [ ] **Step 2: If the wasm target is missing, add it.**

Run: `rustup target add wasm32-wasip1` (fall back to `wasm32-unknown-unknown` only if the Shopify CLI's function build requires it — the CLI's Rust function template dictates the exact target; do not override it).
Expected: target installed. No commit (environment change only).

---

## Phase 1 — `discount-tier` Rust function

### Task 1.1: Scaffold the Rust function extension (both targets, fail-safe empty output)

**Files:**
- Create: `extensions/discount-tier/shopify.extension.toml`
- Create: `extensions/discount-tier/Cargo.toml`
- Create: `extensions/discount-tier/src/main.rs`
- Create: `extensions/discount-tier/src/cart_lines_run.graphql`
- Create: `extensions/discount-tier/src/delivery_run.graphql`

**Interfaces:**
- Produces: a compiling Wasm function exporting `cart.lines.discounts.generate.run` and `cart.delivery-options.discounts.generate.run`, both returning empty operations until the engine is wired. Establishes module names `config`, `shared`, `engine` used by later tasks.

- [ ] **Step 1: Scaffold via the CLI to get correct boilerplate.** From repo root:

```bash
npx shopify app generate extension --template discount --name discount-tier --flavor rust
```
This creates `extensions/discount-tier/` with a Rust `Cargo.toml`, a `shopify.extension.toml`, `src/`, and the `[extensions.build] path = "dist/function.wasm"` wiring for the current CLI. If the interactive prompt differs, choose the "Discounts — Rust" function template. (If the CLI cannot run non-interactively here, the maintainer runs the command in-session via `!`.)

- [ ] **Step 2: Overwrite `extensions/discount-tier/shopify.extension.toml`** to pin api_version, un-share identity, declare both targets, and link the UI. Generate a fresh uid with `uuidgen | tr 'A-Z' 'a-z'` and paste it into `uid`:

```toml
api_version = "2026-01"

[[extensions]]
name = "Discount Tier"
handle = "discount-tier"
type = "function"
uid = "PASTE-FRESH-UUID-HERE"
description = "Volume/tier product discount"

  [[extensions.targeting]]
  target = "cart.lines.discounts.generate.run"
  input_query = "src/cart_lines_run.graphql"
  export = "cart-lines-discounts-generate-run"

  [[extensions.targeting]]
  target = "cart.delivery-options.discounts.generate.run"
  input_query = "src/delivery_run.graphql"
  export = "cart-delivery-options-discounts-generate-run"

  [extensions.build]
  path = "dist/function.wasm"

  [extensions.ui]
  handle = "discount-tier-ui"
```

- [ ] **Step 3: Write the input query** `src/cart_lines_run.graphql` — same fields as eva's, but reading the **un-shared** namespace `$app:discount-tier`:

```graphql
query CartInput {
  triggeringDiscountCode
  cart {
    attribute(key: "platform_source") { key value }
    discountCode: attribute(key: "discountCode") { key value }
    lines {
      id
      quantity
      cost {
        subtotalAmount { amount }
        amountPerQuantity { amount }
        compareAtAmountPerQuantity { amount }
      }
      merchandise { ... on ProductVariant { id product { id } } }
    }
  }
  discount { discountClasses }
  discount { metafield(namespace: "$app:discount-tier", key: "config") { value } }
  shop { metafield(namespace: "checkout", key: "priority_codes") { value } }
}
```

- [ ] **Step 4: Write the delivery input query** `src/delivery_run.graphql` (minimal; the target is a no-op):

```graphql
query DeliveryInput {
  cart { deliveryGroups { id } }
  discount { discountClasses }
}
```

- [ ] **Step 5: Write `src/main.rs`** wiring both targets to return empty operations for now. Use the `shopify_function` crate's target macro and generated types (the crate generates types from the input queries at build). Both run functions return an empty `FunctionRunResult { operations: vec![] }`:

```rust
mod config;
mod engine;
mod shared;

use shopify_function::prelude::*;
use shopify_function::Result;

// Types are generated from the .graphql input queries by the shopify_function macro.
#[shopify_function_target(
    query_path = "src/cart_lines_run.graphql",
    schema_path = "schema.graphql"
)]
fn cart_lines_discounts_generate_run(
    input: input::ResponseData,
) -> Result<output::FunctionRunResult> {
    // Wired to the engine in Task 1.4. Fail-safe default: no operations.
    let _ = input;
    Ok(output::FunctionRunResult { operations: vec![] })
}

#[shopify_function_target(
    query_path = "src/delivery_run.graphql",
    schema_path = "schema.graphql"
)]
fn cart_delivery_options_discounts_generate_run(
    input: input::ResponseData,
) -> Result<output::FunctionRunResult> {
    let _ = input;
    Ok(output::FunctionRunResult { operations: vec![] })
}
```

> The exact macro name / generated-module layout comes from the scaffolded template in Step 1 — match whatever it generated (e.g. `generate_types!` + `#[shopify_function]`). Keep the two exported function names equal to the `export` values in the toml. Do not invent an API the installed `shopify_function` crate version does not expose; follow the scaffold.

- [ ] **Step 6: Ensure `schema.graphql` exists** for codegen. Run:

```bash
cd extensions/discount-tier && npx shopify app function typegen && cd -
```
Expected: writes/refreshes `schema.graphql` + generated types; no error.

- [ ] **Step 7: Build to Wasm.**

Run: `cd extensions/discount-tier && npx shopify app function build && cd -`
Expected: produces `dist/function.wasm`, exit 0.

- [ ] **Step 8: Commit.**

```bash
git add extensions/discount-tier
git commit -m "feat(discount-tier): scaffold Rust function extension (both targets, empty-safe)"
```

### Task 1.2: Config serde structs (tolerant, fail-safe)

**Files:**
- Modify: `extensions/discount-tier/src/config.rs`
- Test: `extensions/discount-tier/tests/config.rs`

**Interfaces:**
- Produces: `TierConfig`, `TierEntry`, and enums `ApplyTo` (`Price`/`CompareAtPrice`), `DiscountType` (`Percentage`/`Percent`/`Amount`), `SelectionStrategy` (`All`/`First`/`Maximum`), `SelectorType` (`VariantId`/`ProductId`), `PlatformCfg` (`Both`/`Pos`/`Checkout`), `PriorityCode { code: String, selector: Selector }`, `Selector` (`Prefix`/`Suffix`/`Exact`). Consumed by `shared.rs` + `engine.rs`.
- `pub fn parse_tier_config(raw: Option<&str>) -> Option<TierConfig>` — returns `None` on null/empty/parse-error (fail-safe).

- [ ] **Step 1: Write the failing test** `tests/config.rs`:

```rust
use discount_tier::config::{parse_tier_config, DiscountType, SelectionStrategy};

#[test]
fn parses_keyed_tiers_and_defaults() {
    let raw = r#"{
      "rule_type":"tier-discount",
      "apply_to":"price",
      "discount_type":"percentage",
      "product_discount_selection_strategy":"ALL",
      "platform":"BOTH",
      "discount_tiers":{"20":{"product_selector_type":"variant_id","targets":[111,222],"min_qty":2,
        "targets_full":[{"variantId":"111"}]}}
    }"#;
    let cfg = parse_tier_config(Some(raw)).expect("should parse");
    assert!(matches!(cfg.discount_type, DiscountType::Percentage));
    assert!(matches!(cfg.selection_strategy, SelectionStrategy::All));
    let tier = cfg.discount_tiers.get("20").unwrap();
    assert_eq!(tier.targets, vec![111, 222]);
    assert_eq!(tier.min_qty, Some(2));
}

#[test]
fn null_and_garbage_are_fail_safe() {
    assert!(parse_tier_config(None).is_none());
    assert!(parse_tier_config(Some("")).is_none());
    assert!(parse_tier_config(Some("not json")).is_none());
}

#[test]
fn unknown_fields_ignored() {
    let raw = r#"{"discount_tiers":{},"totally_unknown":42,"rule_type":"tier-discount"}"#;
    assert!(parse_tier_config(Some(raw)).is_some());
}
```

- [ ] **Step 2: Run it, verify failure.**

Run: `cd extensions/discount-tier && cargo test --test config`
Expected: FAIL (module/functions not defined).

- [ ] **Step 3: Implement `src/config.rs`:**

```rust
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyTo { Price, CompareAtPrice }
impl Default for ApplyTo { fn default() -> Self { ApplyTo::Price } }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscountType { Percentage, Percent, Amount }
impl Default for DiscountType { fn default() -> Self { DiscountType::Percentage } }

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum SelectionStrategy { All, First, Maximum }
impl Default for SelectionStrategy { fn default() -> Self { SelectionStrategy::All } }

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectorType { VariantId, ProductId }
impl Default for SelectorType { fn default() -> Self { SelectorType::ProductId } } // matches JS _normalizeSelectorType default

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum PlatformCfg { Both, Pos, Checkout }
impl Default for PlatformCfg { fn default() -> Self { PlatformCfg::Both } }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Selector { Prefix, Suffix, Exact }
impl Default for Selector { fn default() -> Self { Selector::Exact } }

#[derive(Debug, Deserialize)]
pub struct PriorityCode {
    pub code: String,
    #[serde(default)] pub selector: Selector,
}

#[derive(Debug, Default, Deserialize)]
pub struct TierEntry {
    #[serde(default)] pub product_selector_type: SelectorType,
    #[serde(default)] pub targets: Vec<i64>,
    #[serde(default)] pub min_qty: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TierConfig {
    #[serde(default)] pub message: Option<String>,
    #[serde(default)] pub apply_to: ApplyTo,
    #[serde(default)] pub discount_type: DiscountType,
    #[serde(default, rename = "product_discount_selection_strategy")]
    pub selection_strategy: SelectionStrategy,
    #[serde(default)] pub platform: PlatformCfg,
    #[serde(default)] pub discount_tiers: BTreeMap<String, TierEntry>,
}

pub fn parse_tier_config(raw: Option<&str>) -> Option<TierConfig> {
    let s = raw?;
    if s.trim().is_empty() { return None; }
    serde_json::from_str::<TierConfig>(s).ok()
}
```

> Add `pub mod config;` etc. to a `src/lib.rs` (or expose modules) so the `discount_tier::config` path resolves in tests. If the scaffold uses a binary-only crate, add a `[lib]` target to `Cargo.toml` (`name = "discount_tier"`, `path = "src/lib.rs"`) re-exporting `pub mod config; pub mod shared; pub mod engine;`, and have `main.rs` (the wasm bin) `use discount_tier::...`. This dual bin+lib layout is what lets `cargo test` exercise pure logic without the wasm entrypoint.

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd extensions/discount-tier && cargo test --test config`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add extensions/discount-tier/src/config.rs extensions/discount-tier/src/lib.rs extensions/discount-tier/Cargo.toml extensions/discount-tier/tests/config.rs
git commit -m "feat(discount-tier): tolerant fail-safe config serde structs"
```

### Task 1.3: Shared helpers (gid, matching, subtotal, apply_to, platform, code-yield, op builder)

**Files:**
- Modify: `extensions/discount-tier/src/shared.rs`
- Test: `extensions/discount-tier/tests/shared.rs`

**Interfaces:**
- Produces (all `pub`):
  - `id_from_gid(&str) -> Option<i64>` — numeric tail of a `gid://…/<id>`.
  - `line_matches(selector: SelectorType, variant_id: Option<i64>, product_id: Option<i64>, targets: &BTreeSet<i64>) -> bool` — variant match; product match with variant fallback.
  - `current_platform(attr_value: Option<&str>) -> PlatformCfg` — `POS` if attr upper == "POS" else `Checkout`.
  - `platform_allowed(cfg: PlatformCfg, current: PlatformCfg) -> bool` — `Both` or equal.
  - `should_yield(triggering_code: Option<&str>, cart_code: Option<&str>, codes: &[PriorityCode]) -> bool` — never yield when code-triggered; else prefix/suffix/exact match.
  - `strategy_enum(SelectionStrategy) -> &'static str` — `"ALL"|"FIRST"|"MAXIMUM"`.
- Consumed by `engine.rs` and `main.rs`.

- [ ] **Step 1: Write the failing test** `tests/shared.rs`:

```rust
use std::collections::BTreeSet;
use discount_tier::config::{SelectorType, PlatformCfg, PriorityCode, Selector};
use discount_tier::shared::*;

#[test]
fn gid_tail() {
    assert_eq!(id_from_gid("gid://shopify/ProductVariant/111"), Some(111));
    assert_eq!(id_from_gid("garbage"), None);
}

#[test]
fn product_selector_falls_back_to_variant() {
    let targets: BTreeSet<i64> = [111].into_iter().collect();
    // product_id absent, variant matches → true (fallback)
    assert!(line_matches(SelectorType::ProductId, Some(111), None, &targets));
    // variant selector requires variant match
    assert!(line_matches(SelectorType::VariantId, Some(111), Some(999), &targets));
    assert!(!line_matches(SelectorType::VariantId, Some(222), Some(999), &targets));
}

#[test]
fn platform_and_yield_rules() {
    assert!(matches!(current_platform(Some("pos")), PlatformCfg::Pos));
    assert!(platform_allowed(PlatformCfg::Both, PlatformCfg::Pos));
    assert!(!platform_allowed(PlatformCfg::Pos, PlatformCfg::Checkout));

    let codes = vec![PriorityCode { code: "VIP".into(), selector: Selector::Prefix }];
    // code-triggered run: never yield
    assert!(!should_yield(Some("ANY"), Some("VIPXYZ"), &codes));
    // automatic run + prefix match: yield
    assert!(should_yield(None, Some("VIPXYZ"), &codes));
    assert!(!should_yield(None, Some("NOPE"), &codes));
}
```

- [ ] **Step 2: Run it, verify failure.**

Run: `cd extensions/discount-tier && cargo test --test shared`
Expected: FAIL (unresolved `shared::*`).

- [ ] **Step 3: Implement `src/shared.rs`:**

```rust
use std::collections::BTreeSet;
use crate::config::{SelectorType, PlatformCfg, PriorityCode, Selector, SelectionStrategy};

pub fn id_from_gid(gid: &str) -> Option<i64> {
    gid.rsplit('/').next()?.parse::<i64>().ok()
}

pub fn line_matches(
    selector: SelectorType,
    variant_id: Option<i64>,
    product_id: Option<i64>,
    targets: &BTreeSet<i64>,
) -> bool {
    match selector {
        SelectorType::VariantId => variant_id.map_or(false, |v| targets.contains(&v)),
        SelectorType::ProductId => {
            if let Some(p) = product_id {
                targets.contains(&p)
            } else {
                variant_id.map_or(false, |v| targets.contains(&v))
            }
        }
    }
}

pub fn current_platform(attr_value: Option<&str>) -> PlatformCfg {
    match attr_value {
        Some(v) if v.to_uppercase() == "POS" => PlatformCfg::Pos,
        _ => PlatformCfg::Checkout,
    }
}

pub fn platform_allowed(cfg: PlatformCfg, current: PlatformCfg) -> bool {
    matches!(cfg, PlatformCfg::Both)
        || matches!((cfg, current),
            (PlatformCfg::Pos, PlatformCfg::Pos) | (PlatformCfg::Checkout, PlatformCfg::Checkout))
}

pub fn should_yield(
    triggering_code: Option<&str>,
    cart_code: Option<&str>,
    codes: &[PriorityCode],
) -> bool {
    if let Some(t) = triggering_code { if !t.is_empty() { return false; } }
    let cart = match cart_code { Some(c) if !c.is_empty() => c, _ => return false };
    codes.iter().any(|c| match c.selector {
        Selector::Prefix => cart.starts_with(&c.code),
        Selector::Suffix => cart.ends_with(&c.code),
        Selector::Exact => cart == c.code,
    })
}

pub fn strategy_enum(s: SelectionStrategy) -> &'static str {
    match s {
        SelectionStrategy::All => "ALL",
        SelectionStrategy::First => "FIRST",
        SelectionStrategy::Maximum => "MAXIMUM",
    }
}
```

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd extensions/discount-tier && cargo test --test shared`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add extensions/discount-tier/src/shared.rs extensions/discount-tier/tests/shared.rs
git commit -m "feat(discount-tier): shared cart-input helpers (gid, matching, platform, code-yield)"
```

### Task 1.4: Tier engine — standard (price) path

**Files:**
- Modify: `extensions/discount-tier/src/engine.rs`
- Test: `extensions/discount-tier/tests/engine_standard.rs`

**Interfaces:**
- Consumes: `config::TierConfig`, `shared::*`.
- Produces:
  - `pub struct Line { pub id: String, pub quantity: u32, pub variant_id: Option<i64>, pub product_id: Option<i64>, pub subtotal: f64, pub amount_per_qty: f64, pub compare_at_per_qty: Option<f64> }`
  - `pub struct Candidate { pub message: String, pub target_ids: Vec<String>, pub value: DiscountValue }`
  - `pub enum DiscountValue { Percentage(f64), FixedAmountNum(f64), FixedAmountStr(String) }`
  - `pub fn build_candidates(cfg: &TierConfig, lines: &[Line]) -> Vec<Candidate>` — the ported algorithm (both paths; compare-at added in Task 1.5).
- Consumed by `main.rs` (Task 1.6 wires it to the generated output types).

- [ ] **Step 1: Write the failing test** `tests/engine_standard.rs`:

```rust
use discount_tier::config::*;
use discount_tier::engine::*;
use std::collections::BTreeMap;

fn line(id: &str, qty: u32, variant: i64, product: i64, price: f64) -> Line {
    Line { id: id.into(), quantity: qty, variant_id: Some(variant), product_id: Some(product),
        subtotal: price * qty as f64, amount_per_qty: price, compare_at_per_qty: None }
}

fn cfg_with(strategy: SelectionStrategy, min_qty: Option<u32>) -> TierConfig {
    let mut tiers = BTreeMap::new();
    tiers.insert("20".to_string(), TierEntry {
        product_selector_type: SelectorType::VariantId, targets: vec![111], min_qty });
    TierConfig { message: Some("FLASH".into()), apply_to: ApplyTo::Price,
        discount_type: DiscountType::Percentage, selection_strategy: strategy,
        platform: PlatformCfg::Both, discount_tiers: tiers }
}

#[test]
fn all_eligible_lines_get_percentage_and_message() {
    let cfg = cfg_with(SelectionStrategy::All, None);
    let lines = vec![line("l1", 1, 111, 10, 50.0), line("l2", 1, 999, 20, 80.0)];
    let c = build_candidates(&cfg, &lines);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].target_ids, vec!["l1"]); // only variant 111 matches
    assert_eq!(c[0].message, "FLASH 20% OFF");
    assert!(matches!(c[0].value, DiscountValue::Percentage(v) if (v - 20.0).abs() < 1e-9));
}

#[test]
fn per_line_min_qty_excludes_below_threshold() {
    let cfg = cfg_with(SelectionStrategy::All, Some(2));
    let lines = vec![line("l1", 1, 111, 10, 50.0)]; // qty 1 < min_qty 2
    assert!(build_candidates(&cfg, &lines).is_empty());
}

#[test]
fn maximum_picks_highest_subtotal_line() {
    let cfg = {
        let mut c = cfg_with(SelectionStrategy::Maximum, None);
        c.discount_tiers.get_mut("20").unwrap().targets = vec![111, 222];
        c
    };
    let lines = vec![
        line("small", 1, 111, 10, 10.0),
        line("big", 1, 222, 20, 90.0),
    ];
    let c = build_candidates(&cfg, &lines);
    assert_eq!(c[0].target_ids, vec!["big"]);
}

#[test]
fn message_without_prefix_is_bare_percent_off() {
    let mut cfg = cfg_with(SelectionStrategy::All, None);
    cfg.message = None;
    let lines = vec![line("l1", 1, 111, 10, 50.0)];
    let c = build_candidates(&cfg, &lines);
    assert_eq!(c[0].message, "20% OFF");
}

#[test]
fn amount_type_emits_fixed_amount_number() {
    let mut cfg = cfg_with(SelectionStrategy::All, None);
    cfg.discount_type = DiscountType::Amount;
    let lines = vec![line("l1", 1, 111, 10, 50.0)];
    let c = build_candidates(&cfg, &lines);
    assert!(matches!(c[0].value, DiscountValue::FixedAmountNum(v) if (v - 20.0).abs() < 1e-9));
}
```

- [ ] **Step 2: Run it, verify failure.**

Run: `cd extensions/discount-tier && cargo test --test engine_standard`
Expected: FAIL (engine types/fn missing).

- [ ] **Step 3: Implement `src/engine.rs`** (standard path; compare-at branch returns the standard candidate for now and is completed in Task 1.5). Faithful to `tier_discount.js`:

```rust
use std::collections::BTreeSet;
use crate::config::{TierConfig, TierEntry, DiscountType, ApplyTo, SelectionStrategy, SelectorType};
use crate::shared::line_matches;

#[derive(Debug, Clone)]
pub struct Line {
    pub id: String,
    pub quantity: u32,
    pub variant_id: Option<i64>,
    pub product_id: Option<i64>,
    pub subtotal: f64,
    pub amount_per_qty: f64,
    pub compare_at_per_qty: Option<f64>,
}

#[derive(Debug, Clone)]
pub enum DiscountValue { Percentage(f64), FixedAmountNum(f64), FixedAmountStr(String) }

#[derive(Debug, Clone)]
pub struct Candidate { pub message: String, pub target_ids: Vec<String>, pub value: DiscountValue }

fn is_percentage(cfg: &TierConfig) -> bool {
    matches!(cfg.discount_type, DiscountType::Percentage | DiscountType::Percent)
}

fn tier_message(cfg: &TierConfig, tier_key: f64) -> String {
    let key = format_num(tier_key);
    match &cfg.message {
        Some(m) if !m.trim().is_empty() => format!("{} {}% OFF", m, key),
        _ => format!("{}% OFF", key),
    }
}

// Render a tier key like JS Number→String: integers without a trailing .0
fn format_num(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{}", n) }
}

fn eligible_lines<'a>(lines: &'a [Line], selector: SelectorType, targets: &BTreeSet<i64>, min_qty: u32) -> Vec<&'a Line> {
    lines.iter().filter(|l| {
        if !line_matches(selector, l.variant_id, l.product_id, targets) { return false; }
        if min_qty > 0 { l.quantity >= min_qty } else { true }
    }).collect()
}

fn select_targets<'a>(eligible: &[&'a Line], strategy: SelectionStrategy, tier_key: f64) -> Vec<&'a Line> {
    if eligible.is_empty() { return vec![]; }
    match strategy {
        SelectionStrategy::First => vec![eligible[0]],
        SelectionStrategy::All => eligible.to_vec(),
        SelectionStrategy::Maximum => {
            // highest subtotal * (tier_key/100); strict >, ties keep earlier
            let mut best = eligible[0];
            let mut best_disc = best.subtotal * (tier_key / 100.0);
            for l in &eligible[1..] {
                let d = l.subtotal * (tier_key / 100.0);
                if d > best_disc { best = l; best_disc = d; }
            }
            vec![best]
        }
    }
}

pub fn build_candidates(cfg: &TierConfig, lines: &[Line]) -> Vec<Candidate> {
    if cfg.discount_tiers.is_empty() { return vec![]; }
    let mut out = Vec::new();
    for (key, entry) in &cfg.discount_tiers {
        let tier_key: f64 = match key.parse() { Ok(v) => v, Err(_) => continue };
        let targets: BTreeSet<i64> = entry.targets.iter().copied().collect();
        let min_qty = entry.min_qty.unwrap_or(0);
        let eligible = eligible_lines(lines, entry.product_selector_type, &targets, min_qty);
        let selected = select_targets(&eligible, cfg.selection_strategy, tier_key);
        if selected.is_empty() { continue; }
        let message = tier_message(cfg, tier_key);

        match cfg.apply_to {
            ApplyTo::CompareAtPrice => {
                out.extend(build_compare_at(cfg, tier_key, &selected, &message));
            }
            ApplyTo::Price => {
                let value = if is_percentage(cfg) {
                    DiscountValue::Percentage(tier_key)
                } else if matches!(cfg.discount_type, DiscountType::Amount) {
                    DiscountValue::FixedAmountNum(tier_key)
                } else {
                    DiscountValue::Percentage(tier_key)
                };
                out.push(Candidate {
                    message,
                    target_ids: selected.iter().map(|l| l.id.clone()).collect(),
                    value,
                });
            }
        }
    }
    out
}

// Completed in Task 1.5.
fn build_compare_at(_cfg: &TierConfig, _tier_key: f64, selected: &[&Line], message: &str) -> Vec<Candidate> {
    // placeholder replaced in Task 1.5 — for now, mirror the standard percentage candidate
    vec![Candidate { message: message.to_string(),
        target_ids: selected.iter().map(|l| l.id.clone()).collect(),
        value: DiscountValue::Percentage(_tier_key) }]
}
```

> Note: `select_targets` returns one target per selected line for `ALL`, but the standard-path candidate groups all selected lines into a single candidate's `target_ids` (matching JS `buildTargetsForTier` → one candidate with N targets). The compare-at path (Task 1.5) instead emits **one candidate per line**. This asymmetry is faithful to the JS.

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd extensions/discount-tier && cargo test --test engine_standard`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add extensions/discount-tier/src/engine.rs extensions/discount-tier/tests/engine_standard.rs
git commit -m "feat(discount-tier): tier engine standard/price path (tiers, min_qty, strategies)"
```

### Task 1.5: Tier engine — compare-at-price path

**Files:**
- Modify: `extensions/discount-tier/src/engine.rs` (replace `build_compare_at`)
- Test: `extensions/discount-tier/tests/engine_compare_at.rs`

**Interfaces:**
- Produces: completed `build_compare_at` emitting one `Candidate` per line with `DiscountValue::FixedAmountStr` (rounded to 2 dp, stringified), skipping lines where `compare_at < current`, falling back to selling price when compare-at absent/≤0.

- [ ] **Step 1: Write the failing test** `tests/engine_compare_at.rs`:

```rust
use discount_tier::config::*;
use discount_tier::engine::*;
use std::collections::BTreeMap;

fn cfg(dt: DiscountType) -> TierConfig {
    let mut tiers = BTreeMap::new();
    tiers.insert("20".to_string(), TierEntry {
        product_selector_type: SelectorType::VariantId, targets: vec![111], min_qty: None });
    TierConfig { message: None, apply_to: ApplyTo::CompareAtPrice, discount_type: dt,
        selection_strategy: SelectionStrategy::All, platform: PlatformCfg::Both, discount_tiers: tiers }
}

fn line(id: &str, qty: u32, price: f64, compare_at: Option<f64>) -> Line {
    Line { id: id.into(), quantity: qty, variant_id: Some(111), product_id: Some(10),
        subtotal: price * qty as f64, amount_per_qty: price, compare_at_per_qty: compare_at }
}

#[test]
fn percentage_off_compare_at_yields_string_fixed_amount() {
    // compareAt=100, current=80, 20% off compareAt → desiredFinal=80 → discount = 80-80 = 0? use compareAt=120
    let c = build_candidates(&cfg(DiscountType::Percentage), &[line("l1", 2, 80.0, Some(120.0))]);
    assert_eq!(c.len(), 1);
    // desiredFinal = 120*(1-0.2)=96; per-item discount = max(0, 80-96)=0 → total "0"
    match &c[0].value { DiscountValue::FixedAmountStr(s) => assert_eq!(s, "0"), _ => panic!() }
}

#[test]
fn skips_line_when_compare_at_below_current() {
    let c = build_candidates(&cfg(DiscountType::Percentage), &[line("l1", 1, 80.0, Some(50.0))]);
    assert!(c.is_empty()); // compareAt(50) < current(80) → skip
}

#[test]
fn amount_type_is_min_of_value_and_current_times_qty() {
    // amount 20, current 80, qty 2 → per-item min(20,80)=20 → total 40 → "40"
    let c = build_candidates(&cfg(DiscountType::Amount), &[line("l1", 2, 80.0, Some(120.0))]);
    match &c[0].value { DiscountValue::FixedAmountStr(s) => assert_eq!(s, "40"), _ => panic!() }
}

#[test]
fn missing_compare_at_falls_back_to_selling_price() {
    // compareAt None → fallback = current(80); percentage 20% → desiredFinal 64; discount per item 16; qty1 → "16"
    let c = build_candidates(&cfg(DiscountType::Percentage), &[line("l1", 1, 80.0, None)]);
    match &c[0].value { DiscountValue::FixedAmountStr(s) => assert_eq!(s, "16"), _ => panic!() }
}
```

- [ ] **Step 2: Run it, verify failure.**

Run: `cd extensions/discount-tier && cargo test --test engine_compare_at`
Expected: FAIL (placeholder returns Percentage, not FixedAmountStr).

- [ ] **Step 3: Replace `build_compare_at`** in `src/engine.rs`:

```rust
fn build_compare_at(cfg: &TierConfig, tier_key: f64, selected: &[&Line], message: &str) -> Vec<Candidate> {
    let percentage = is_percentage(cfg);
    selected.iter().filter_map(|l| {
        let current = l.amount_per_qty;
        if current <= 0.0 { return None; }
        // compare-at fallback: >0 else current
        let compare_at = match l.compare_at_per_qty { Some(c) if c > 0.0 => c, _ => current };
        if compare_at < current { return None; } // invalid compare-at → skip
        let per_item = if percentage {
            let desired_final = compare_at * (1.0 - tier_key / 100.0);
            (current - desired_final).max(0.0)
        } else {
            tier_key.min(current) // amount type
        };
        let total = (per_item * l.quantity as f64 * 100.0).round() / 100.0;
        Some(Candidate {
            message: message.to_string(),
            target_ids: vec![l.id.clone()],
            value: DiscountValue::FixedAmountStr(format_num(total)),
        })
    }).collect()
}
```

> `format_num` renders `40.0 → "40"`, `16.5 → "16.5"` — matching JS `String(Math.round(x*100)/100)` for the common integer/short-decimal cases. If a fixture needs exact 2-dp formatting (e.g. `"16.50"`), adjust `format_num` for the compare-at path only after checking the JS output for that fixture.

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd extensions/discount-tier && cargo test --test engine_compare_at && cargo test`
Expected: PASS (all engine + config + shared tests).

- [ ] **Step 5: Commit.**

```bash
git add extensions/discount-tier/src/engine.rs extensions/discount-tier/tests/engine_compare_at.rs
git commit -m "feat(discount-tier): compare-at-price path (per-line fixedAmount, fallback, skip)"
```

### Task 1.6: Wire engine to run targets + JS→Rust parity fixtures

**Files:**
- Modify: `extensions/discount-tier/src/main.rs`
- Create: `extensions/discount-tier/tests/fixtures/tier_payload1.input.json`, `.../tier_payload1.expected.json` (+ payload2)
- Test: `extensions/discount-tier/tests/parity.rs`

**Interfaces:**
- Consumes: `engine::build_candidates`, `shared::{should_yield, current_platform, platform_allowed, strategy_enum}`, `config::parse_tier_config`.
- Produces: the wired `cart.lines.discounts.generate.run` that maps generated input → `Line`s, applies yield/platform gates, builds candidates, and returns a single `productDiscountsAdd` operation; delivery target stays empty. Parity harness asserting Rust output == JS output on the eva payloads.

- [ ] **Step 1: Generate the JS baseline outputs** to snapshot expected results. In the eva repo, run the existing handler against `local/payload/payload1.js` and `payload2.js` and capture the emitted operations JSON. Run:

```bash
cd /Users/hassanahmed/code/eva/discount-engine
node local/main.js > /tmp/eva_payload_out.json 2>&1 || cat local/main.js
cd -
```
Inspect `/tmp/eva_payload_out.json` (or run the vitest tier tests with a JSON reporter) to get the exact operations the JS tier handler emits for each payload. Copy the tier-config metafield + cart lines into `tests/fixtures/tier_payload1.input.json` and the emitted `operations[0].productDiscountsAdd` into `tier_payload1.expected.json`. Repeat for payload2.

> If `local/main.js` is not directly runnable, extract the input from `payload1.js`/`payload2.js` and the expected output from the corresponding `extensions/discount-function/tests/*.test.js` assertions — those already encode the JS handler's expected operations. Do not hand-fabricate expected values; they must come from the JS handler.

- [ ] **Step 2: Write the failing parity test** `tests/parity.rs`:

```rust
use discount_tier::config::parse_tier_config;
use discount_tier::engine::{build_candidates, Line, DiscountValue};
use serde_json::Value;

// Minimal input shape mirroring the fixture (config value + lines).
fn load(name: &str) -> (Value, Value) {
    let input: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("tests/fixtures/{name}.input.json")).unwrap()).unwrap();
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("tests/fixtures/{name}.expected.json")).unwrap()).unwrap();
    (input, expected)
}

fn lines_from(input: &Value) -> Vec<Line> {
    input["cart"]["lines"].as_array().unwrap().iter().map(|l| {
        let variant = l["merchandise"]["id"].as_str()
            .and_then(|g| g.rsplit('/').next()).and_then(|s| s.parse().ok());
        let product = l["merchandise"]["product"]["id"].as_str()
            .and_then(|g| g.rsplit('/').next()).and_then(|s| s.parse().ok());
        let apq: f64 = l["cost"]["amountPerQuantity"]["amount"].as_str().unwrap().parse().unwrap();
        let qty = l["quantity"].as_u64().unwrap() as u32;
        let cmp = l["cost"]["compareAtAmountPerQuantity"]["amount"].as_str().and_then(|s| s.parse().ok());
        let sub: f64 = l["cost"]["subtotalAmount"]["amount"].as_str().unwrap().parse().unwrap();
        Line { id: l["id"].as_str().unwrap().into(), quantity: qty,
            variant_id: variant, product_id: product, subtotal: sub, amount_per_qty: apq,
            compare_at_per_qty: cmp }
    }).collect()
}

fn candidate_to_json(message: &str, ids: &[String], value: &DiscountValue) -> Value {
    let value_json = match value {
        DiscountValue::Percentage(v) => serde_json::json!({"percentage": {"value": v}}),
        DiscountValue::FixedAmountNum(v) => serde_json::json!({"fixedAmount": {"amount": v}}),
        DiscountValue::FixedAmountStr(s) => serde_json::json!({"fixedAmount": {"amount": s}}),
    };
    serde_json::json!({
        "message": message,
        "targets": ids.iter().map(|id| serde_json::json!({"cartLine": {"id": id}})).collect::<Vec<_>>(),
        "value": value_json
    })
}

#[test]
fn payload1_parity() {
    let (input, expected) = load("tier_payload1");
    let cfg = parse_tier_config(input["config"].as_str()).unwrap();
    let lines = lines_from(&input);
    let candidates = build_candidates(&cfg, &lines);
    let got: Vec<Value> = candidates.iter()
        .map(|c| candidate_to_json(&c.message, &c.target_ids, &c.value)).collect();
    let expected_candidates = expected["candidates"].as_array().unwrap();
    assert_eq!(got.len(), expected_candidates.len(), "candidate count");
    for (g, e) in got.iter().zip(expected_candidates) {
        assert_eq!(g, e, "candidate mismatch");
    }
}
```

Add an identical `payload2_parity` test for the second fixture.

- [ ] **Step 2b: Run it, verify failure.**

Run: `cd extensions/discount-tier && cargo test --test parity`
Expected: FAIL until fixtures + engine agree (or missing fixtures).

- [ ] **Step 3: Wire `main.rs`** to map generated input types → `engine::Line` and emit the operation. Use the generated types from the scaffold; the mapping mirrors `lines_from` above but reads the generated structs. Build the operation as `productDiscountsAdd { candidates, selectionStrategy: strategy_enum(cfg.selection_strategy) }`, applying the gates in order: `should_yield` → empty; `!platform_allowed` → empty; else candidates. Convert each `Candidate` into the generated output candidate type (percentage vs fixedAmount; string vs number amount per `DiscountValue`).

```rust
// Sketch — adapt field paths to the generated `input` module:
let raw_cfg = input.discount.metafield.map(|m| m.value); // Option<String>
let cfg = match config::parse_tier_config(raw_cfg.as_deref()) {
    Some(c) => c, None => return Ok(output::FunctionRunResult { operations: vec![] }),
};
let triggering = input.triggering_discount_code.as_deref();
let cart_code = input.cart.discount_code.as_ref().and_then(|a| a.value.as_deref());
let codes: Vec<config::PriorityCode> = input.shop.metafield.as_ref()
    .and_then(|m| serde_json::from_str(&m.value).ok()).unwrap_or_default();
if shared::should_yield(triggering, cart_code, &codes) {
    return Ok(output::FunctionRunResult { operations: vec![] });
}
let platform_attr = input.cart.attribute.as_ref().and_then(|a| a.value.as_deref());
if !shared::platform_allowed(cfg.platform, shared::current_platform(platform_attr)) {
    return Ok(output::FunctionRunResult { operations: vec![] });
}
let lines = /* map input.cart.lines -> Vec<engine::Line> */;
let candidates = engine::build_candidates(&cfg, &lines);
if candidates.is_empty() {
    return Ok(output::FunctionRunResult { operations: vec![] });
}
// map candidates -> generated ProductDiscountsAdd operation with selectionStrategy
```

> Keep the pure logic in `engine`/`shared` (already unit-tested); `main.rs` is only the generated-type adapter. The parity test exercises `engine` directly, so it does not depend on the wasm entrypoint.

- [ ] **Step 4: Make fixtures + engine agree; run parity + build.**

Run:
```bash
cd extensions/discount-tier && cargo test && npx shopify app function build && cd -
```
Expected: all tests PASS; `dist/function.wasm` builds. If a parity candidate mismatches, fix the **engine** to match the JS output (the JS is the source of truth), not the fixture.

- [ ] **Step 5: Add edge fixtures** — empty cart → `[]`; oversized/`null` config → `[]`; platform mismatch → `[]`; automatic run + matching `checkout:priority_codes` code → `[]`. Add a `tests/edge.rs` asserting each returns empty. Run `cargo test --test edge`, expect PASS.

- [ ] **Step 6: Commit.**

```bash
git add extensions/discount-tier
git commit -m "feat(discount-tier): wire engine to run targets + JS→Rust parity + edge fixtures"
```

---

## Phase 2 — `discount-tier-ui` admin UI extension

### Task 2.1: Scaffold the admin UI extension + shared metafield helper + definition ensure

**Files:**
- Create: `extensions/discount-tier-ui/shopify.extension.toml`
- Create: `extensions/discount-tier-ui/package.json`
- Create: `extensions/discount-tier-ui/src/DiscountTierSettings.jsx`
- Create: `extensions/shared/metafield.js`

**Interfaces:**
- Produces: `metafield.js` exporting `makeMetafieldApi(namespace, key)` → `{ getMetafieldDefinition, createMetafieldDefinition, parseMetafield }`; the UI entry that ensures the `$app:discount-tier`/`config` definition then renders.

- [ ] **Step 1: Scaffold via CLI** to get the correct ui_extension boilerplate:

```bash
npx shopify app generate extension --template ui_extension --name discount-tier-ui
```
Choose target `admin.discount-details.function-settings.render` if prompted.

- [ ] **Step 2: Overwrite `shopify.extension.toml`** (fresh uid via `uuidgen`):

```toml
api_version = "2025-10"

[[extensions]]
name = "Discount Tier Settings"
description = "Configure tier/volume discounts"
handle = "discount-tier-ui"
type = "ui_extension"
uid = "PASTE-FRESH-UUID-HERE"

  [[extensions.targeting]]
  module = "./src/DiscountTierSettings.jsx"
  target = "admin.discount-details.function-settings.render"
```

- [ ] **Step 3: Write `package.json`** (match eva's deps, pin real versions — resolve the `.x` to concrete published versions):

```json
{
  "name": "discount-tier-ui",
  "private": true,
  "version": "1.0.0",
  "license": "UNLICENSED",
  "dependencies": {
    "preact": "^10.10.0",
    "@shopify/ui-extensions": "2025.10.0"
  }
}
```

Run `npm install` in the extension dir; if `@shopify/ui-extensions@2025.10.0` is not the latest patch, pin to the actual installed patch version.

- [ ] **Step 4: Write `extensions/shared/metafield.js`** — parameterized port of eva's `utils/metafield.js`:

```js
export function makeMetafieldApi(namespace, key) {
  async function getMetafieldDefinition() {
    const query = `#graphql
      query GetMetafieldDefinition {
        metafieldDefinitions(first: 1, ownerType: DISCOUNT, namespace: "${namespace}", key: "${key}") {
          nodes { id }
        }
      }`;
    const result = await shopify.query(query);
    return result?.data?.metafieldDefinitions?.nodes?.[0];
  }

  async function createMetafieldDefinition() {
    const definition = {
      access: { admin: "MERCHANT_READ_WRITE" },
      key, name: "Discount Configuration", namespace,
      ownerType: "DISCOUNT", type: "json",
    };
    const query = `#graphql
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } }
      }`;
    const result = await shopify.query(query, { variables: { definition } });
    return result?.data?.metafieldDefinitionCreate?.createdDefinition;
  }

  return { getMetafieldDefinition, createMetafieldDefinition, namespace, key };
}
```

- [ ] **Step 5: Write `src/DiscountTierSettings.jsx`** (entry — ensure-then-create, then render):

```jsx
import { render } from "preact";
import { makeMetafieldApi } from "../../shared/metafield.js";
import App from "./App.jsx";

const NAMESPACE = "$app:discount-tier";
const KEY = "config";

export default async () => {
  const api = makeMetafieldApi(NAMESPACE, KEY);
  const existing = await api.getMetafieldDefinition();
  if (!existing) {
    const created = await api.createMetafieldDefinition();
    if (!created) throw new Error("Failed to create metafield definition"); // fail loudly
  }
  render(<App api={api} />, document.body);
};
```

- [ ] **Step 6: Add a placeholder `src/App.jsx`** so the extension builds (real form in Task 2.2):

```jsx
export default function App() {
  return <s-function-settings><s-section heading="Tier discount">Loading…</s-section></s-function-settings>;
}
```

- [ ] **Step 7: Build the extension.**

Run: `npx shopify app build` (from repo root) — or `npx shopify app dev` to preview against a dev store.
Expected: `discount-tier-ui` compiles with no error.

- [ ] **Step 8: Commit.**

```bash
git add extensions/discount-tier-ui extensions/shared/metafield.js
git commit -m "feat(discount-tier-ui): scaffold admin UI extension + shared metafield definition helper"
```

### Task 2.2: Shared single-type form-state hook (build/validate/size)

**Files:**
- Create: `extensions/shared/hooks/useExtensionData.js`
- Test: `extensions/shared/hooks/useExtensionData.test.js` (vitest — add a minimal vitest setup to `extensions/shared` if none exists)

**Interfaces:**
- Produces (pure, testable exports, no Preact needed): `buildTierConfig(formData) -> object`, `validateTierConfig(formData) -> string[]`, `METAFIELD_MAX_SIZE_BYTES = 10240`, `getMetafieldSizeBytes(formData) -> number`, `validateMetafieldSize(valueStr)` (throws >10 KB). The hook `useExtensionData({ api, initial })` wraps these + `applyExtensionMetafieldChange`.

- [ ] **Step 1: Write the failing test** `useExtensionData.test.js`:

```js
import { describe, it, expect } from "vitest";
import { buildTierConfig, validateTierConfig, getMetafieldSizeBytes, METAFIELD_MAX_SIZE_BYTES } from "./useExtensionData.js";

const form = {
  ruleType: "tier-discount", discountCodeMatchType: "exact", message: "FLASH",
  applyTo: "price", discountType: "percentage", productDiscountSelectionStrategy: "ALL",
  platform: "BOTH",
  tiers: [{ id: "t1", value: "20", selectorType: "variant_id",
    targets: JSON.stringify([{ variantId: "111", productId: "10", productTitle: "P", variantTitle: "V", sku: "S" }]),
    min_qty: "2" }],
};

it("emits snake_case tier config with numeric targets + targets_full", () => {
  const cfg = buildTierConfig(form);
  expect(cfg.rule_type).toBe("tier-discount");
  expect(cfg.discount_tiers["20"].targets).toEqual([111]);
  expect(cfg.discount_tiers["20"].product_selector_type).toBe("variant_id");
  expect(cfg.discount_tiers["20"].min_qty).toBe(2);
  expect(cfg.discount_tiers["20"].targets_full.length).toBe(1);
});

it("validates required fields", () => {
  expect(validateTierConfig(form)).toEqual([]);
  expect(validateTierConfig({ ...form, discountType: "" })).toContain("Discount Type is required for tier discount.");
  expect(validateTierConfig({ ...form, tiers: [] })).toContain("At least one discount tier is required.");
});

it("measures serialized size", () => {
  expect(getMetafieldSizeBytes(form)).toBeGreaterThan(0);
  expect(METAFIELD_MAX_SIZE_BYTES).toBe(10240);
});
```

- [ ] **Step 2: Run it, verify failure.**

Run: `cd extensions/shared && npx vitest run hooks/useExtensionData.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `hooks/useExtensionData.js`** — port the tier branch of eva's `buildConfigFromFormData`, `validateTierConfig`, and size utils (single-type; no `rule_type` select logic):

```js
import { useState, useMemo, useCallback } from "preact/hooks";

export const METAFIELD_MAX_SIZE_BYTES = 10 * 1024;

function ensureArray(x) { return Array.isArray(x) ? x : []; }

export function buildTierConfig(formData) {
  const {
    ruleType = "tier-discount", discountCodeMatchType = "exact", message = "",
    applyTo = "price", discountType = "percentage",
    productDiscountSelectionStrategy = "ALL", platform = "BOTH", tiers = [],
  } = formData;

  const discount_tiers = {};
  for (const tier of ensureArray(tiers)) {
    if (!tier.targets || !tier.targets.trim()) continue;
    let items = [];
    try { items = JSON.parse(tier.targets); } catch { continue; }
    if (!items.length) continue;
    const selectorType = tier.selectorType || "variant_id";
    const isProductId = selectorType === "product_id";
    const ids = (isProductId
      ? items.map((i) => i.productId)
      : items.map((i) => i.variantId)
    ).filter(Boolean).map(Number);
    if (ids.length === 0) continue;
    const tierKey = tier.value;
    const minQty = tier.min_qty !== "" && tier.min_qty != null ? parseInt(tier.min_qty, 10) : 0;
    const entry = {
      product_selector_type: selectorType,
      targets: ids,
      targets_full: items,
      ...(minQty > 0 ? { min_qty: minQty } : {}),
    };
    if (discount_tiers[tierKey]) {
      const merged = new Set([...discount_tiers[tierKey].targets, ...ids]);
      discount_tiers[tierKey].targets = [...merged];
      const keyField = isProductId ? "productId" : "variantId";
      const map = new Map(discount_tiers[tierKey].targets_full.map((i) => [i[keyField], i]));
      for (const i of items) map.set(i[keyField], i);
      discount_tiers[tierKey].targets_full = [...map.values()];
      if (minQty > 0) discount_tiers[tierKey].min_qty = minQty;
    } else {
      discount_tiers[tierKey] = entry;
    }
  }

  return {
    rule_type: ruleType,
    discount_code_match_type: discountCodeMatchType,
    message,
    apply_to: applyTo,
    discount_type: discountType,
    product_discount_selection_strategy: productDiscountSelectionStrategy,
    platform,
    discount_tiers,
  };
}

export function validateTierConfig(formData) {
  const errors = [];
  const { discountType, platform, tiers } = formData;
  const tiersArr = ensureArray(tiers);
  if (!discountType) errors.push("Discount Type is required for tier discount.");
  if (!platform) errors.push("Platform is required for tier discount.");
  if (!Array.isArray(tiers) || tiersArr.length === 0) {
    errors.push("At least one discount tier is required.");
  } else {
    tiersArr.forEach((tier, index) => {
      if (tier.value == null || String(tier.value).trim() === "") {
        errors.push(`Tier ${index + 1}: Discount percentage/amount is required.`);
      }
      let count = 0;
      try { count = ensureArray(JSON.parse(tier.targets)).length; } catch { count = 0; }
      if (count === 0) errors.push(`Tier ${index + 1}: At least one product or variant must be selected.`);
    });
  }
  return errors;
}

export function getMetafieldValueString(formData) {
  try { return JSON.stringify(buildTierConfig(formData)); } catch { return "{}"; }
}

export function getMetafieldSizeBytes(formData) {
  return new TextEncoder().encode(getMetafieldValueString(formData)).length;
}

export function validateMetafieldSize(valueStr) {
  if (valueStr == null) return;
  const sizeBytes = new TextEncoder().encode(String(valueStr)).length;
  if (sizeBytes > METAFIELD_MAX_SIZE_BYTES) {
    throw new Error(`Discount configuration is too large (${(sizeBytes / 1024).toFixed(1)}KB). Maximum size is 10KB. Please reduce the number of tiers.`);
  }
}

export function useExtensionData({ api, initial }) {
  const [formData, setFormData] = useState(initial);
  const sizeBytes = useMemo(() => getMetafieldSizeBytes(formData), [formData]);
  const validationErrors = useMemo(() => validateTierConfig(formData), [formData]);

  const applyExtensionMetafieldChange = useCallback(async () => {
    const errors = validateTierConfig(formData);
    if (errors.length > 0) throw new Error(errors.join(" "));
    const valueStr = getMetafieldValueString(formData);
    validateMetafieldSize(valueStr);
    await shopify.applyMetafieldChange({
      type: "updateMetafield", namespace: api.namespace, key: api.key,
      value: valueStr, valueType: "json",
    });
  }, [formData, api]);

  return { formData, setFormData, sizeBytes, validationErrors, applyExtensionMetafieldChange };
}
```

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd extensions/shared && npx vitest run hooks/useExtensionData.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add extensions/shared/hooks/useExtensionData.js extensions/shared/hooks/useExtensionData.test.js extensions/shared/package.json extensions/shared/vitest.config.js
git commit -m "feat(shared): single-type tier form-state (build/validate/size), unit-tested"
```

### Task 2.3: TierCard + inline chips + resource picker

**Files:**
- Create: `extensions/shared/components/TierCard.jsx`
- Create: `extensions/shared/components/ConfigurationPreview.jsx`

**Interfaces:**
- Consumes: `shopify.resourcePicker` (runtime global).
- Produces: `TierCard({ tier, tierIndex, onUpdate, onRemove, discountType, allTiers })` and `ConfigurationPreview({ formData })`, both imported by `App.jsx` (Task 2.4). Stores selection as JSON in `tier.targets` (`targets_full`-shaped objects with `productId`/`variantId`/`productTitle`/`variantTitle`/`sku`).

- [ ] **Step 1: Port `TierCard.jsx`** from eva verbatim (it already renders inline chips and drives `shopify.resourcePicker` with variant/product branches). Key behaviours to preserve (from the digest):
  - `selectorType = tier.selectorType || 'variant_id'`; product vs variant picker branches.
  - Variant branch builds `selectionIds` grouped by product with `variants`; product branch uses `{ id: gid://…/Product/<id> }`.
  - Result mapping extracts `productId`/`variantId` via `/Product\/(\d+)$/` and `/ProductVariant\/(\d+)$/`, dedupes by id, filters `excludedVariantIds` (variants selected in other tiers).
  - Chip labels: product → `productTitle || productId`; variant → `sku ? "${productTitle} - ${sku}" : "${productTitle} - ${variantTitle||variantId}"`.
  - Selector-type change clears `targets` to `'[]'`.
  - `s-number-field` for `value` (label/suffix by `discountType`, clamp 0..100 for percentage) and for `min_qty`.

Copy the eva source at `extensions/discount-ui/src/components/TierCard.jsx` and adjust only imports (`preact/hooks`) and the props signature above. Do not change the resource-picker call shapes.

- [ ] **Step 2: Port `ConfigurationPreview.jsx`** from eva (tier recap banner) — a read-only summary of the current tiers; keep it tier-specific.

- [ ] **Step 3: Build to verify JSX compiles.**

Run: `npx shopify app build`
Expected: no error (components compile even if not yet mounted).

- [ ] **Step 4: Commit.**

```bash
git add extensions/shared/components/TierCard.jsx extensions/shared/components/ConfigurationPreview.jsx
git commit -m "feat(shared): port TierCard (inline chips + resourcePicker) + ConfigurationPreview"
```

### Task 2.4: Tier form App + write path + validation/size banners

**Files:**
- Modify: `extensions/discount-tier-ui/src/App.jsx`

**Interfaces:**
- Consumes: `useExtensionData`, `TierCard`, `ConfigurationPreview`, `parseMetafield` (add a tier `parseMetafield` to `shared/metafield.js`), `shopify.data`.
- Produces: the full tier authoring form bound to `<s-function-settings onSubmit={applyExtensionMetafieldChange}>`.

- [ ] **Step 1: Add `parseMetafield` to `shared/metafield.js`** (tier-only; keyed-object → `tiers` array), returning the form-state defaults from the digest (ruleType `tier-discount`, applyTo `price`, discountType `percentage`, strategy `ALL`, platform `BOTH`, one empty tier when none). Port from eva's `parseMetafield` tier branch.

- [ ] **Step 2: Implement `App.jsx`:**

```jsx
import { useMemo } from "preact/hooks";
import { useExtensionData } from "../../shared/hooks/useExtensionData.js";
import TierCard from "../../shared/components/TierCard.jsx";
import ConfigurationPreview from "../../shared/components/ConfigurationPreview.jsx";

export default function App({ api }) {
  const initial = useMemo(() => {
    const mf = shopify.data?.metafields?.find((m) => m.key === "config");
    return api.parseMetafield(mf?.value);
  }, [api]);

  const { formData, setFormData, sizeBytes, validationErrors, applyExtensionMetafieldChange } =
    useExtensionData({ api, initial });

  const tiers = formData.tiers || [];
  const update = (patch) => setFormData({ ...formData, ...patch });
  const updateTier = (i, field, value) => {
    const next = tiers.map((t, idx) => (idx === i ? { ...t, [field]: value } : t));
    update({ tiers: next });
  };
  const addTier = () => update({ tiers: [...tiers, { id: `tier-${tiers.length}`, value: "0", selectorType: "variant_id", targets: "[]", min_qty: "" }] });
  const removeTier = (i) => update({ tiers: tiers.filter((_, idx) => idx !== i) });

  const kb = (sizeBytes / 1024).toFixed(2);
  const overWarn = sizeBytes > 8192;
  const overLimit = sizeBytes > 10240;

  return (
    <s-function-settings onSubmit={applyExtensionMetafieldChange}>
      {validationErrors.length > 0 && (
        <s-banner tone="critical" heading="Please fix the following errors:">
          <s-unordered-list>{validationErrors.map((e) => <s-list-item>{e}</s-list-item>)}</s-unordered-list>
        </s-banner>
      )}
      {overWarn && (
        <s-banner tone={overLimit ? "critical" : "warning"}>
          Metafield size: {kb} KB / 10 KB {overLimit ? "(exceeds limit)" : ""}
        </s-banner>
      )}
      <s-section heading="Discount details">
        <s-select label="Discount type" value={formData.discountType}
          onChange={(e) => update({ discountType: e.target.value })}>
          <s-option value="percentage">Percentage</s-option>
          <s-option value="amount">Amount</s-option>
        </s-select>
        <s-select label="Apply to" value={formData.applyTo}
          onChange={(e) => update({ applyTo: e.target.value })}>
          <s-option value="price">Price</s-option>
          <s-option value="compare_at_price">Compare-at price</s-option>
        </s-select>
        <s-select label="Platform" value={formData.platform}
          onChange={(e) => update({ platform: e.target.value })}>
          <s-option value="BOTH">Both</s-option>
          <s-option value="POS">POS</s-option>
          <s-option value="CHECKOUT">Checkout</s-option>
        </s-select>
        <s-select label="Selection strategy" value={formData.productDiscountSelectionStrategy}
          onChange={(e) => update({ productDiscountSelectionStrategy: e.target.value })}>
          <s-option value="ALL">All</s-option>
          <s-option value="FIRST">First</s-option>
          <s-option value="MAXIMUM">Maximum</s-option>
        </s-select>
        <s-text-field label="Message" value={formData.message}
          onChange={(e) => update({ message: e.target.value })} />
      </s-section>
      <s-section heading="Savings levels">
        {tiers.map((t, i) => (
          <TierCard tier={t} tierIndex={i} discountType={formData.discountType} allTiers={tiers}
            onUpdate={(f, v) => updateTier(i, f, v)} onRemove={() => removeTier(i)} />
        ))}
        <s-button onClick={addTier}>Add another level</s-button>
      </s-section>
      <ConfigurationPreview formData={formData} />
    </s-function-settings>
  );
}
```

> Match `s-*` element/attribute names to the installed `@shopify/ui-extensions` 2025.10 admin API. If a tag differs (e.g. list elements), adjust to the version's actual components — the digest's `App.jsx`/`TierCard.jsx` are the reference for exact tag usage.

- [ ] **Step 3: Build.**

Run: `npx shopify app build`
Expected: no error.

- [ ] **Step 4: Commit.**

```bash
git add extensions/discount-tier-ui/src/App.jsx extensions/shared/metafield.js
git commit -m "feat(discount-tier-ui): tier authoring form + write path + validation/size banners"
```

### Task 2.5: Manual dev-store round-trip verification

**Files:** none (verification task).

**Interfaces:** proves the full slice works against a real store: UI writes `$app:discount-tier.config`; the function reads it and discounts a cart.

- [ ] **Step 1: Run the app against a dev store.**

Run: `npx shopify app dev` (maintainer runs in-session via `!` if auth/tunnel is interactive).
Expected: both `discount-tier` (function) and `discount-tier-ui` register; a preview URL is printed.

- [ ] **Step 2: Create a discount using the app function.** In the dev store admin → Discounts → Create → App → pick **Discount Jet · Discount Tier**. Confirm the `discount-tier-ui` renders in the function-settings block (no rule_type/mode select). Configure one tier (e.g. 20% off a chosen variant, min_qty 1), Save.

- [ ] **Step 3: Verify the metafield write.** Confirm Save succeeds and the discount persists. (Optional: query the discount's `$app:discount-tier`/`config` metafield to confirm snake_case JSON with numeric `targets` + `targets_full`.)

- [ ] **Step 4: Verify the function discounts a cart.** Add the targeted variant to a cart at the required quantity; confirm the tier discount applies with the expected message (`"{message} 20% OFF"` or `"20% OFF"`). Test a non-matching product gets nothing; test min_qty gating.

- [ ] **Step 5: Record results** in the PR description (screenshots or a short note of the observed discount). No commit.

---

## Follow-up (out of this plan)

Once this slice is green and reviewed, replicate the exact task template for the other two types as their own plans:
- `2026-08-27-discount-bundle-vertical-slice.md` — port `bundle_discount.js` (entitlement math: `_resolveMaxDiscountQty`, `fixed_ratios`/`max_target_qty`, `shared_pool`, message-only source candidates) + `discount-bundle-ui`.
- `2026-08-27-discount-special-vertical-slice.md` — port `special_discount.js` (`_normalizeTargets` incl. legacy single-target, `_resolveSharedPool` cross-group, per-group selection strategy) + `discount-special-ui`.

Deferred (per E2/E3 open questions, not in these slices): extracting a shared Rust crate (default: duplicate `shared.rs`/`config.rs` per extension); metafield migration from the old `$app:discount-engine` key (greenfield here — no existing data); the embedded-app deep-link to the native create-discount page (E3-6 UX); the `[extensions.ui]` linkage will fail `shopify app deploy` until each function's paired UI exists — build/deploy the function + its UI together.
```