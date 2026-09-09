//! Pass 2 — config-driven cart line transformer ("CartTransformer" /
//! applier). Ported behaviour-faithfully from `eva/discount-engine`'s
//! `cart-transform-applier.js`.

use crate::config::EngineConfig;
use crate::shared::{CartLine, ExpandedItemOut, LineExpandOp};
use std::collections::HashSet;

/// Mirrors JS `CartTransformer.getVariantId`.
pub fn get_variant_id(line: &CartLine) -> Option<i64> {
    line.variant_id
}

/// Mirrors JS `CartTransformer.platformSourceMatches`. A cart with no
/// `platform_source` attribute is treated as `"CHECKOUT"`. A config with no
/// `platform_source` value mirrors JS's `String(undefined).toUpperCase()`
/// ("UNDEFINED"), which never matches a real platform and so never passes
/// (unless the config also sets `"BOTH"`).
pub fn platform_source_matches(config: &EngineConfig, current_platform: Option<&str>) -> bool {
    let input = current_platform.unwrap_or("CHECKOUT").to_uppercase();
    let sources: Vec<String> = match &config.platform_source {
        Some(v) => v.as_upper_set(),
        None => vec!["UNDEFINED".to_string()],
    };
    if sources.iter().any(|s| s == "BOTH") {
        return true;
    }
    sources.contains(&input)
}

/// Mirrors JS `CartTransformer.conditionPassed`. `ALL` requires every source
/// variant to be present in the cart; anything else (including `ANY`,
/// missing, or unrecognized) always passes.
pub fn condition_passed(config: &EngineConfig, cart_variant_ids: &[i64]) -> bool {
    match config.condition.as_deref() {
        Some("ALL") => {
            !config.source_variants.is_empty()
                && config.source_variants.iter().all(|v| cart_variant_ids.contains(v))
        }
        _ => true,
    }
}

/// Mirrors JS `CartTransformer.findSourceLine`: the first cart line whose
/// variant id is in `source_variants` and that hasn't already been claimed by
/// this or an earlier pass.
pub fn find_source_line<'a>(
    lines: &'a [CartLine],
    source_variants: &[i64],
    processed: &HashSet<String>,
) -> Option<&'a CartLine> {
    lines.iter().find(|line| {
        get_variant_id(line).is_some_and(|v| source_variants.contains(&v)) && !processed.contains(&line.id)
    })
}

/// Mirrors JS `CartTransformer.resolveTargetPrice`.
///  - `"%"` — percentage deducted from the base price
///  - anything else (including `"-"`, missing, or unrecognized) — a fixed
///    amount deducted from the base price
///
/// Result is formatted to 2 decimal places, mirroring JS `.toFixed(2)`.
pub fn resolve_target_price(value: f64, operator: Option<&str>, base_price: &str) -> String {
    let base: f64 = base_price.parse().unwrap_or(f64::NAN);
    let result = match operator {
        Some("%") => base - (base * value / 100.0),
        _ => base - value,
    };
    format!("{:.2}", result)
}

/// Mirrors JS `CartTransformer.buildExpandedItems`.
///
/// The source item keeps quantity 1 (Shopify multiplies by the line's own
/// quantity) at its current `amountPerQuantity` (falling back to `"0"` if
/// absent). Each target variant gets a fresh expanded item priced via
/// `resolve_target_price`. Message attributes are applied to the source,
/// target, or both, per `config.apply_to_message` (`"source"` | `"target"` |
/// anything else / absent -> both).
pub fn build_expanded_items(source_line: &CartLine, config: &EngineConfig) -> Vec<ExpandedItemOut> {
    let source_price = source_line
        .amount_per_quantity
        .clone()
        .unwrap_or_else(|| "0".to_string());

    let apply_to_message = config.apply_to_message.as_deref().map(|s| s.to_lowercase());
    let apply_to_source = apply_to_message.as_deref() == Some("source") || apply_to_message.is_none();
    let apply_to_target = apply_to_message.as_deref() == Some("target") || apply_to_message.is_none();

    let message_attrs: Vec<(String, String)> =
        config.message.iter().map(|m| (m.key.clone(), m.value.clone())).collect();
    let has_message = !message_attrs.is_empty();

    let mut items = Vec::with_capacity(1 + config.target_variants.len());

    items.push(ExpandedItemOut {
        merchandise_id: source_line.variant_gid.clone().unwrap_or_default(),
        quantity: 1,
        attributes: if has_message && apply_to_source {
            message_attrs.clone()
        } else {
            Vec::new()
        },
        price_amount: Some(source_price),
    });

    for variant in &config.target_variants {
        let price = resolve_target_price(config.value, config.operator.as_deref(), &variant.price);
        items.push(ExpandedItemOut {
            merchandise_id: format!("gid://shopify/ProductVariant/{}", variant.id),
            quantity: config.target_quantity.unwrap_or(1),
            attributes: if has_message && apply_to_target {
                message_attrs.clone()
            } else {
                Vec::new()
            },
            price_amount: Some(price),
        });
    }

    items
}

/// Mirrors JS `CartTransformer.applyConfig`. Returns `None` (no-op) if the
/// config is inactive, platform-filtered out, its condition isn't met, or no
/// eligible (unprocessed) source line is found.
pub fn apply_config(
    config: &EngineConfig,
    lines: &[CartLine],
    cart_variant_ids: &[i64],
    current_platform: Option<&str>,
    processed: &HashSet<String>,
) -> Option<LineExpandOp> {
    if config.active == Some(false) {
        return None;
    }
    if !platform_source_matches(config, current_platform) {
        return None;
    }
    if !condition_passed(config, cart_variant_ids) {
        return None;
    }
    let source_line = find_source_line(lines, &config.source_variants, processed)?;

    Some(LineExpandOp {
        cart_line_id: source_line.id.clone(),
        expanded_items: build_expanded_items(source_line, config),
        title: config.title.clone(),
    })
}

/// Mirrors JS `CartTransformer.transform`. Iterates all configs in order,
/// applying each against the shared `processed` set so that no cart line is
/// claimed twice (across configs, or across the bundle-expander pass that ran
/// before this one).
pub fn transform(
    configs: &[EngineConfig],
    lines: &[CartLine],
    current_platform: Option<&str>,
    processed: &mut HashSet<String>,
) -> Vec<LineExpandOp> {
    let cart_variant_ids: Vec<i64> = lines.iter().filter_map(get_variant_id).collect();
    let mut ops = Vec::new();
    for config in configs {
        if let Some(op) = apply_config(config, lines, &cart_variant_ids, current_platform, processed) {
            processed.insert(op.cart_line_id.clone());
            ops.push(op);
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MessageAttr, PlatformSourceValue, TargetVariant};

    fn line(variant_id: i64, id: &str, price: &str) -> CartLine {
        CartLine {
            id: id.to_string(),
            is_product_variant: true,
            variant_gid: Some(format!("gid://shopify/ProductVariant/{variant_id}")),
            variant_id: Some(variant_id),
            product_title: None,
            composition: None,
            amount_per_quantity: Some(price.to_string()),
            subtotal_amount: None,
            quantity: 1,
        }
    }

    fn config_any() -> EngineConfig {
        EngineConfig {
            active: None,
            title: Some("hassan".to_string()),
            message: vec![MessageAttr { key: "test".to_string(), value: "hassan".to_string() }],
            apply_to_message: Some("source".to_string()),
            platform_source: Some(PlatformSourceValue::One("BOTH".to_string())),
            target_quantity: Some(1),
            source_variants: vec![
                48121306906908,
                48121306939676,
                48121306972444,
                48121307005212,
                48121307037980,
            ],
            target_variants: vec![TargetVariant {
                id: 48121307529500,
                price: "109.00".to_string(),
                compare_at_price: Some("149.00".to_string()),
            }],
            condition: Some("ANY".to_string()),
            value: 50.0,
            operator: Some("%".to_string()),
        }
    }

    fn config_all() -> EngineConfig {
        EngineConfig {
            active: None,
            title: Some("ghhmgjm".to_string()),
            message: vec![],
            apply_to_message: Some("source".to_string()),
            platform_source: Some(PlatformSourceValue::One("BOTH".to_string())),
            target_quantity: Some(1),
            source_variants: vec![48121306906908, 48121306939676],
            target_variants: vec![TargetVariant {
                id: 48121307529500,
                price: "109.00".to_string(),
                compare_at_price: Some("149.00".to_string()),
            }],
            condition: Some("ALL".to_string()),
            value: 10.0,
            operator: Some("%".to_string()),
        }
    }

    #[test]
    fn get_variant_id_extracts_numeric_id() {
        let l = line(48121306906908, "line_1", "100.00");
        assert_eq!(get_variant_id(&l), Some(48121306906908));
    }

    #[test]
    fn platform_both_matches_null_and_pos() {
        let cfg = EngineConfig { platform_source: Some(PlatformSourceValue::One("BOTH".to_string())), ..config_any() };
        assert!(platform_source_matches(&cfg, None));
        assert!(platform_source_matches(&cfg, Some("POS")));
    }

    #[test]
    fn platform_checkout_matches_null_cart() {
        let cfg = EngineConfig { platform_source: Some(PlatformSourceValue::One("CHECKOUT".to_string())), ..config_any() };
        assert!(platform_source_matches(&cfg, None));
    }

    #[test]
    fn platform_checkout_does_not_match_pos() {
        let cfg = EngineConfig { platform_source: Some(PlatformSourceValue::One("CHECKOUT".to_string())), ..config_any() };
        assert!(!platform_source_matches(&cfg, Some("POS")));
    }

    #[test]
    fn platform_case_insensitive() {
        let cfg = EngineConfig { platform_source: Some(PlatformSourceValue::One("pos".to_string())), ..config_any() };
        assert!(platform_source_matches(&cfg, Some("POS")));
        let cfg2 = EngineConfig { platform_source: Some(PlatformSourceValue::One("POS".to_string())), ..config_any() };
        assert!(platform_source_matches(&cfg2, Some("pos")));
    }

    #[test]
    fn platform_array_supported() {
        let cfg = EngineConfig {
            platform_source: Some(PlatformSourceValue::Many(vec!["CHECKOUT".to_string(), "POS".to_string()])),
            ..config_any()
        };
        assert!(platform_source_matches(&cfg, Some("POS")));
        let cfg2 = EngineConfig {
            platform_source: Some(PlatformSourceValue::Many(vec!["CHECKOUT".to_string()])),
            ..config_any()
        };
        assert!(!platform_source_matches(&cfg2, Some("POS")));
        let cfg3 = EngineConfig {
            platform_source: Some(PlatformSourceValue::Many(vec!["CHECKOUT".to_string(), "BOTH".to_string()])),
            ..config_any()
        };
        assert!(platform_source_matches(&cfg3, Some("POS")));
    }

    #[test]
    fn condition_any_always_true() {
        let cfg = EngineConfig { condition: Some("ANY".to_string()), source_variants: vec![], ..config_any() };
        assert!(condition_passed(&cfg, &[]));
        let cfg2 = EngineConfig { condition: None, source_variants: vec![], ..config_any() };
        assert!(condition_passed(&cfg2, &[]));
    }

    #[test]
    fn condition_all_requires_every_source_present() {
        assert!(condition_passed(&config_all(), &[48121306906908, 48121306939676]));
        assert!(!condition_passed(&config_all(), &[48121306906908]));
        assert!(!condition_passed(&config_all(), &[]));
        let cfg = EngineConfig { source_variants: vec![], ..config_all() };
        assert!(!condition_passed(&cfg, &[48121306906908]));
    }

    #[test]
    fn condition_all_ignores_target_presence() {
        // Targets absent from cart still passes — bundle will add them.
        assert!(condition_passed(&config_all(), &[48121306906908, 48121306939676]));
    }

    #[test]
    fn find_source_line_returns_first_match_skipping_processed() {
        let lines = vec![line(48121306906908, "line_A", "1"), line(48121306939676, "line_B", "1")];
        let ids = [48121306906908, 48121306939676];
        assert_eq!(find_source_line(&lines, &ids, &HashSet::new()).unwrap().id, "line_A");
        let mut processed = HashSet::new();
        processed.insert("line_A".to_string());
        assert_eq!(find_source_line(&lines, &ids, &processed).unwrap().id, "line_B");
        processed.insert("line_B".to_string());
        assert!(find_source_line(&lines, &ids, &processed).is_none());
        assert!(find_source_line(&lines, &[999999], &HashSet::new()).is_none());
    }

    #[test]
    fn resolve_target_price_percentage() {
        assert_eq!(resolve_target_price(50.0, Some("%"), "109.00"), "54.50");
        assert_eq!(resolve_target_price(10.0, Some("%"), "109.00"), "98.10");
        assert_eq!(resolve_target_price(0.0, Some("%"), "100.00"), "100.00");
        assert_eq!(resolve_target_price(100.0, Some("%"), "100.00"), "0.00");
    }

    #[test]
    fn resolve_target_price_fixed_and_unknown_operator() {
        assert_eq!(resolve_target_price(20.0, Some("-"), "109.00"), "89.00");
        assert_eq!(resolve_target_price(5.0, Some("UNKNOWN"), "109.00"), "104.00");
        assert_eq!(resolve_target_price(0.0, Some("-"), "50.00"), "50.00");
    }

    #[test]
    fn build_expanded_items_source_and_target() {
        let source = line(48121306906908, "line_A", "79.99");
        let items = build_expanded_items(&source, &config_any());
        assert_eq!(items[0].merchandise_id, "gid://shopify/ProductVariant/48121306906908");
        assert_eq!(items[0].quantity, 1);
        assert_eq!(items[0].price_amount.as_deref(), Some("79.99"));
        assert_eq!(items[1].merchandise_id, "gid://shopify/ProductVariant/48121307529500");
        assert_eq!(items[1].price_amount.as_deref(), Some("54.50"));
    }

    #[test]
    fn build_expanded_items_target_quantity_defaults_to_one() {
        let source = line(48121306906908, "line_A", "79.99");
        let cfg = EngineConfig { target_quantity: None, ..config_any() };
        let items = build_expanded_items(&source, &cfg);
        assert_eq!(items[1].quantity, 1);
        let cfg2 = EngineConfig { target_quantity: Some(3), ..config_any() };
        let items2 = build_expanded_items(&source, &cfg2);
        assert_eq!(items2[1].quantity, 3);
    }

    #[test]
    fn build_expanded_items_apply_to_message_variants() {
        let source = line(48121306906908, "line_A", "79.99");

        let cfg_source = EngineConfig { apply_to_message: Some("source".to_string()), ..config_any() };
        let items = build_expanded_items(&source, &cfg_source);
        assert!(!items[0].attributes.is_empty());
        assert!(items[1].attributes.is_empty());

        let cfg_target = EngineConfig { apply_to_message: Some("target".to_string()), ..config_any() };
        let items = build_expanded_items(&source, &cfg_target);
        assert!(items[0].attributes.is_empty());
        assert!(!items[1].attributes.is_empty());

        let cfg_both = EngineConfig { apply_to_message: None, ..config_any() };
        let items = build_expanded_items(&source, &cfg_both);
        assert!(!items[0].attributes.is_empty());
        assert!(!items[1].attributes.is_empty());

        // empty message -> no attributes regardless
        let items = build_expanded_items(&source, &config_all());
        assert!(items[0].attributes.is_empty());
    }

    #[test]
    fn build_expanded_items_missing_cost_falls_back_to_zero() {
        let mut source = line(48121306906908, "line_X", "0");
        source.amount_per_quantity = None;
        let items = build_expanded_items(&source, &config_any());
        assert_eq!(items[0].price_amount.as_deref(), Some("0"));
    }

    #[test]
    fn build_expanded_items_no_targets_yields_only_source() {
        let source = line(48121306906908, "line_A", "79.99");
        let cfg = EngineConfig { target_variants: vec![], ..config_any() };
        assert_eq!(build_expanded_items(&source, &cfg).len(), 1);
    }

    #[test]
    fn build_expanded_items_multiple_targets() {
        let source = line(48121306906908, "line_A", "79.99");
        let cfg = EngineConfig {
            target_variants: vec![
                TargetVariant { id: 111, price: "50.00".to_string(), compare_at_price: None },
                TargetVariant { id: 222, price: "60.00".to_string(), compare_at_price: None },
            ],
            ..config_any()
        };
        assert_eq!(build_expanded_items(&source, &cfg).len(), 3);
    }

    #[test]
    fn apply_config_inactive_returns_none() {
        let lines = vec![line(48121306906908, "line_A", "79.99")];
        let cfg = EngineConfig { active: Some(false), ..config_any() };
        assert!(apply_config(&cfg, &lines, &[48121306906908], None, &HashSet::new()).is_none());
    }

    #[test]
    fn apply_config_platform_mismatch_returns_none() {
        let lines = vec![line(48121306906908, "line_A", "79.99")];
        let cfg = EngineConfig { platform_source: Some(PlatformSourceValue::One("CHECKOUT".to_string())), ..config_any() };
        assert!(apply_config(&cfg, &lines, &[48121306906908], Some("POS"), &HashSet::new()).is_none());
    }

    #[test]
    fn apply_config_condition_fails_returns_none() {
        let lines = vec![line(48121306906908, "line_A", "79.99")];
        assert!(apply_config(&config_all(), &lines, &[48121306906908], None, &HashSet::new()).is_none());
    }

    #[test]
    fn apply_config_no_source_line_returns_none() {
        assert!(apply_config(&config_any(), &[], &[], None, &HashSet::new()).is_none());
    }

    #[test]
    fn apply_config_already_processed_returns_none() {
        let lines = vec![line(48121306906908, "line_A", "79.99")];
        let mut processed = HashSet::new();
        processed.insert("line_A".to_string());
        assert!(apply_config(&config_any(), &lines, &[48121306906908], None, &processed).is_none());
    }

    #[test]
    fn apply_config_success_includes_title() {
        let lines = vec![line(48121306906908, "line_A", "79.99")];
        let op = apply_config(&config_any(), &lines, &[48121306906908], None, &HashSet::new()).unwrap();
        assert_eq!(op.cart_line_id, "line_A");
        assert_eq!(op.title.as_deref(), Some("hassan"));
        assert_eq!(op.expanded_items.len(), 2);
    }

    #[test]
    fn apply_config_omits_title_when_absent() {
        let lines = vec![line(48121306906908, "line_A", "79.99")];
        let cfg = EngineConfig { title: None, ..config_any() };
        let op = apply_config(&cfg, &lines, &[48121306906908], None, &HashSet::new()).unwrap();
        assert!(op.title.is_none());
    }

    #[test]
    fn transform_full_integration() {
        let lines = vec![
            line(48121306906908, "line_A", "79.99"),
            line(48121306939676, "line_B", "89.99"),
        ];
        let mut processed = HashSet::new();
        let ops = transform(&[config_any(), config_all()], &lines, None, &mut processed);
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn transform_same_source_not_expanded_twice() {
        let lines = vec![line(48121306906908, "line_A", "1")];
        let mut processed = HashSet::new();
        let ops = transform(&[config_any(), config_any()], &lines, None, &mut processed);
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn transform_inactive_config_skipped() {
        let lines = vec![line(48121306906908, "line_A", "1")];
        let mut processed = HashSet::new();
        let cfg = EngineConfig { active: Some(false), ..config_any() };
        assert!(transform(&[cfg], &lines, None, &mut processed).is_empty());
    }

    #[test]
    fn transform_empty_cart_no_operations() {
        let mut processed = HashSet::new();
        assert!(transform(&[config_any(), config_all()], &[], None, &mut processed).is_empty());
    }

    #[test]
    fn transform_pos_cart_with_both_config() {
        let lines = vec![line(48121306906908, "line_A", "1")];
        let mut processed = HashSet::new();
        let ops = transform(&[config_any()], &lines, Some("POS"), &mut processed);
        assert_eq!(ops.len(), 1);
    }
}
