//! Pass 3 — merge-bundle applier. Ported behaviour-faithfully from the E6
//! activation spec's merge-bundle behaviour: shop `checkout.merge_bundles`
//! config entries describe a set of "source" variants that, when all present
//! together (and unclaimed) in the cart, get merged into one line
//! representing a parent "bundle" variant, discounted down to a configured
//! target total.
//!
//! Runs *after* bundle expansion (Pass 1) and the config applier (Pass 2),
//! sharing the same `processed` exclusion set: a line already claimed by an
//! earlier pass is never available to be re-claimed here, and a line this
//! pass claims must be recorded so nothing downstream double-claims it.

use crate::config::MergeBundleConfig;
use crate::shared::{id_from_gid, CartLine, LinesMergeOp};
use std::collections::HashSet;

/// Attempt to build a `LinesMergeOp` for a single merge-bundle config.
///
/// Returns `None` (no-op) when:
///  - any configured `sources` entry doesn't parse to a numeric variant id
///    (mirrors `id_from_gid`'s `NaN`-never-matches semantics — an
///    unparseable source can never be satisfied by a real cart line), or
///  - any configured `sources` variant isn't present as an unprocessed cart
///    line (the "all sources present" gate — a merge never partially
///    consumes its sources), or
///  - the matched lines' combined live subtotal is zero or negative (nothing
///    sensible to compute a percentage discount off of).
pub fn apply_config(
    config: &MergeBundleConfig,
    lines: &[CartLine],
    processed: &HashSet<String>,
) -> Option<LinesMergeOp> {
    let source_ids: Vec<i64> = config.sources.iter().filter_map(|s| id_from_gid(s)).collect();
    if source_ids.len() != config.sources.len() {
        return None;
    }

    // Gate: every source variant must be present among the unprocessed cart
    // lines, or this config doesn't fire at all.
    let mut matched: Vec<&CartLine> = Vec::with_capacity(source_ids.len());
    for &source_id in &source_ids {
        let line = lines
            .iter()
            .find(|l| l.variant_id == Some(source_id) && !processed.contains(&l.id))?;
        matched.push(line);
    }

    let subtotal: f64 = matched
        .iter()
        .map(|l| l.subtotal_amount.as_deref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0))
        .sum();
    if subtotal <= 0.0 {
        return None;
    }

    let percentage_decrease = ((1.0 - config.price / subtotal) * 100.0).clamp(0.0, 100.0);
    let cart_lines = matched.iter().map(|l| (l.id.clone(), l.quantity)).collect();

    Some(LinesMergeOp {
        cart_lines,
        parent_variant_id: config.parent_variant_id.clone(),
        percentage_decrease,
        title: config.title.clone(),
    })
}

/// Mirrors the shape of `applier::transform`/`bundle_expander`'s pass
/// integration: iterate all merge configs in order, applying each against
/// the shared `processed` set so a config can never claim a line an earlier
/// config (or an earlier pass) already claimed.
pub fn transform(
    configs: &[MergeBundleConfig],
    lines: &[CartLine],
    processed: &mut HashSet<String>,
) -> Vec<LinesMergeOp> {
    let mut ops = Vec::new();
    for config in configs {
        if let Some(op) = apply_config(config, lines, processed) {
            for (line_id, _) in &op.cart_lines {
                processed.insert(line_id.clone());
            }
            ops.push(op);
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(variant_id: i64, id: &str, subtotal: &str, quantity: i64) -> CartLine {
        CartLine {
            id: id.to_string(),
            is_product_variant: true,
            variant_gid: Some(format!("gid://shopify/ProductVariant/{variant_id}")),
            variant_id: Some(variant_id),
            product_title: None,
            composition: None,
            amount_per_quantity: Some(subtotal.to_string()),
            subtotal_amount: Some(subtotal.to_string()),
            quantity,
        }
    }

    fn config() -> MergeBundleConfig {
        MergeBundleConfig {
            parent_variant_id: "gid://shopify/ProductVariant/999".to_string(),
            price: 49.99,
            sources: vec![
                "gid://shopify/ProductVariant/1".to_string(),
                "gid://shopify/ProductVariant/2".to_string(),
            ],
            title: Some("Merged Bundle".to_string()),
        }
    }

    #[test]
    fn all_sources_present_produces_merge_op() {
        let lines = vec![line(1, "line_A", "30.00", 1), line(2, "line_B", "40.00", 2)];
        let op = apply_config(&config(), &lines, &HashSet::new()).unwrap();
        assert_eq!(op.parent_variant_id, "gid://shopify/ProductVariant/999");
        assert_eq!(op.title.as_deref(), Some("Merged Bundle"));
        assert_eq!(
            op.cart_lines,
            vec![("line_A".to_string(), 1), ("line_B".to_string(), 2)]
        );
        // subtotal = 70.00, price = 49.99 -> pct = (1 - 49.99/70) * 100 = ~28.586%
        assert!((op.percentage_decrease - 28.585_714_285_714_285).abs() < 1e-9);
    }

    #[test]
    fn missing_one_source_yields_no_op() {
        let lines = vec![line(1, "line_A", "30.00", 1)];
        assert!(apply_config(&config(), &lines, &HashSet::new()).is_none());
    }

    #[test]
    fn already_processed_source_line_is_treated_as_absent() {
        let lines = vec![line(1, "line_A", "30.00", 1), line(2, "line_B", "40.00", 1)];
        let mut processed = HashSet::new();
        processed.insert("line_A".to_string());
        assert!(apply_config(&config(), &lines, &processed).is_none());
    }

    #[test]
    fn unparseable_source_gid_yields_no_op() {
        let cfg = MergeBundleConfig { sources: vec!["not-a-gid".to_string()], ..config() };
        let lines = vec![line(1, "line_A", "30.00", 1), line(2, "line_B", "40.00", 1)];
        assert!(apply_config(&cfg, &lines, &HashSet::new()).is_none());
    }

    #[test]
    fn percentage_clamps_to_zero_when_price_meets_or_exceeds_subtotal() {
        let cfg = MergeBundleConfig { price: 100.0, ..config() };
        let lines = vec![line(1, "line_A", "30.00", 1), line(2, "line_B", "40.00", 1)];
        let op = apply_config(&cfg, &lines, &HashSet::new()).unwrap();
        assert_eq!(op.percentage_decrease, 0.0);

        let cfg_equal = MergeBundleConfig { price: 70.0, ..config() };
        let op_equal = apply_config(&cfg_equal, &lines, &HashSet::new()).unwrap();
        assert_eq!(op_equal.percentage_decrease, 0.0);
    }

    #[test]
    fn percentage_clamps_to_hundred_when_price_is_zero_or_negative() {
        let cfg = MergeBundleConfig { price: 0.0, ..config() };
        let lines = vec![line(1, "line_A", "30.00", 1), line(2, "line_B", "40.00", 1)];
        let op = apply_config(&cfg, &lines, &HashSet::new()).unwrap();
        assert_eq!(op.percentage_decrease, 100.0);
    }

    #[test]
    fn zero_or_negative_subtotal_yields_no_op() {
        let lines = vec![line(1, "line_A", "0.00", 1), line(2, "line_B", "0.00", 1)];
        assert!(apply_config(&config(), &lines, &HashSet::new()).is_none());
    }

    #[test]
    fn transform_claims_matched_lines_and_skips_reused_config() {
        let lines = vec![line(1, "line_A", "30.00", 1), line(2, "line_B", "40.00", 1)];
        let mut processed = HashSet::new();
        // Same config twice: second application should find its sources already
        // claimed by the first and produce no additional op.
        let ops = transform(&[config(), config()], &lines, &mut processed);
        assert_eq!(ops.len(), 1);
        assert!(processed.contains("line_A"));
        assert!(processed.contains("line_B"));
    }

    #[test]
    fn transform_empty_configs_yields_no_ops() {
        let lines = vec![line(1, "line_A", "30.00", 1)];
        let mut processed = HashSet::new();
        assert!(transform(&[], &lines, &mut processed).is_empty());
    }
}
