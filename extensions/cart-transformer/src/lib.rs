//! cart-transformer — pure-logic library for the cart transform function.
//! Ported behaviour-faithfully from `eva/discount-engine`'s
//! `cart_transform_run.js` / `cart-transform-orchestrator.js` /
//! `bundle-expander.js` / `cart-transform-applier.js`.
//! Shopify-independent; unit + parity tested.

pub mod applier;
pub mod bundle_expander;
pub mod config;
pub mod merge_applier;
pub mod orchestrator;
pub mod shared;
