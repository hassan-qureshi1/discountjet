//! discount-tier — pure-logic library for the tier/volume discount function.
//!
//! Ported behaviour-faithfully from `eva/discount-engine`'s `tier_discount.js`
//! and the shared coordinator utilities in `shopify-discount-applier.js`.
//! The wasm entrypoint (`main.rs` + `cart_lines_discounts_generate_run.rs`)
//! maps Shopify's generated input types onto these modules; everything here is
//! Shopify-independent and unit + parity tested.

pub mod config;
pub mod engine;
pub mod shared;
