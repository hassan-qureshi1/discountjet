# Extensions

Shopify Functions and admin UI extensions, built/deployed via the Shopify CLI
(`shopify app dev` / `shopify app deploy`) — a path independent of the
Cloudflare Worker (`wrangler deploy`). The Worker hosts OAuth + the embedded
SPA; these extensions run on Shopify's platform.

- `discount-tier/`     — Rust discount function (product discounts by tier)
- `discount-tier-ui/`  — Preact admin UI extension (writes $app:discount-tier.config)
- `shared/`            — shared Preact components/hooks imported by the UI extensions

## discount-tier crate layout

`discount-tier` is a Rust crate split into a pure logic library (`src/lib.rs`
re-exporting `config`, `shared`, `engine`) and — added during the Shopify CLI
wiring step — a wasm entrypoint (`src/main.rs`) using the `shopify_function`
crate. The library carries no Shopify dependency, so `cargo test` runs the full
engine + parity suite standalone (no CLI, no auth). See
`docs/superpowers/plans/2026-08-27-discount-tier-vertical-slice.md`.
