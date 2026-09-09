//! Orchestrates the two passes and merges their operations. Ported
//! behaviour-faithfully from `eva/discount-engine`'s
//! `cart-transform-orchestrator.js`.
//!
//! Pass 1 (bundle expansion) always runs, independent of shop config, and has
//! priority: any line carrying `bundle.composition_v2` is claimed here and
//! never reaches Pass 2. Pass 2 (config-driven transformation) then runs over
//! the remaining lines, sharing the same `processed` exclusion set so no line
//! is ever claimed twice.

use crate::config::EngineConfig;
use crate::shared::{CartLine, LineExpandOp};
use crate::{applier, bundle_expander};
use std::collections::HashSet;

/// Run both passes and return the merged, ordered list of `lineExpand`
/// operations.
///
/// Returns `Err` if a bundle line's `composition_v2` metafield is invalid —
/// mirrors the JS bundle expander throwing, which aborts the whole Function
/// invocation (no partial result is returned).
pub fn transform(
    lines: &[CartLine],
    configs: &[EngineConfig],
    current_platform: Option<&str>,
) -> Result<Vec<LineExpandOp>, String> {
    let mut operations = Vec::new();
    let mut processed: HashSet<String> = HashSet::new();

    // Pass 1: bundle expansion. Has priority — always claims composition_v2 lines.
    for line in lines {
        if let Some(result) = bundle_expander::expand(line) {
            let op = result?;
            processed.insert(op.cart_line_id.clone());
            operations.push(op);
        }
    }

    // Pass 2: config-driven transformations, skipping lines Pass 1 already claimed.
    let mut config_ops = applier::transform(configs, lines, current_platform, &mut processed);
    operations.append(&mut config_ops);

    Ok(operations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EngineConfig, PlatformSourceValue, TargetVariant};

    fn plain_line(variant_id: i64, id: &str, price: &str) -> CartLine {
        CartLine {
            id: id.to_string(),
            is_product_variant: true,
            variant_gid: Some(format!("gid://shopify/ProductVariant/{variant_id}")),
            variant_id: Some(variant_id),
            product_title: None,
            composition: None,
            amount_per_quantity: Some(price.to_string()),
            subtotal_amount: Some(price.to_string()),
        }
    }

    fn bundle_line(id: &str) -> CartLine {
        CartLine {
            id: id.to_string(),
            is_product_variant: true,
            variant_gid: Some("gid://shopify/ProductVariant/111".to_string()),
            variant_id: Some(111),
            product_title: Some("Test Bundle".to_string()),
            composition: Some(r#"[{"id":"gid://shopify/ProductVariant/222","quantity":1,"price":10}]"#.to_string()),
            amount_per_quantity: Some("10.00".to_string()),
            subtotal_amount: Some("10.00".to_string()),
        }
    }

    #[test]
    fn bundle_line_wins_over_config_and_is_excluded_from_pass_two() {
        let variant_id = 111;
        let lines = vec![bundle_line("line_bundle")];
        let cfg = EngineConfig {
            active: None,
            title: None,
            message: vec![],
            apply_to_message: None,
            platform_source: Some(PlatformSourceValue::One("BOTH".to_string())),
            target_quantity: Some(1),
            source_variants: vec![variant_id],
            target_variants: vec![TargetVariant { id: 999, price: "10.00".to_string(), compare_at_price: None }],
            condition: Some("ANY".to_string()),
            value: 1.0,
            operator: Some("-".to_string()),
        };
        let ops = transform(&lines, &[cfg], None).unwrap();
        // Only the bundle-expander operation, not a second one from the applier
        // re-claiming the same line.
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].expanded_items[0].merchandise_id, "gid://shopify/ProductVariant/222");
    }

    #[test]
    fn bundle_and_config_lines_both_produce_operations() {
        let lines = vec![bundle_line("line_bundle"), plain_line(48121306906908, "line_A", "79.99")];
        let cfg = EngineConfig {
            active: None,
            title: None,
            message: vec![],
            apply_to_message: None,
            platform_source: Some(PlatformSourceValue::One("BOTH".to_string())),
            target_quantity: Some(1),
            source_variants: vec![48121306906908],
            target_variants: vec![],
            condition: Some("ANY".to_string()),
            value: 1.0,
            operator: Some("-".to_string()),
        };
        let ops = transform(&lines, &[cfg], None).unwrap();
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn empty_cart_and_empty_config_yields_no_operations() {
        assert!(transform(&[], &[], None).unwrap().is_empty());
    }

    #[test]
    fn invalid_bundle_composition_errors_out() {
        let mut line = bundle_line("line_bundle");
        line.composition = Some("[]".to_string());
        let result = transform(&[line], &[], None);
        assert!(result.is_err());
    }
}
