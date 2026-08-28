//! Edge cases for the tier engine (the yield/platform gates live in the wasm
//! entrypoint and are covered by tests/shared.rs; these cover the engine's own
//! fail-safe paths).

use discount_tier::config::{parse_tier_config, ApplyTo, DiscountType, PlatformCfg, SelectionStrategy, SelectorType, TierConfig, TierEntry};
use discount_tier::engine::{build_candidates, Line};
use std::collections::BTreeMap;

fn tier_cfg() -> TierConfig {
    let mut tiers = BTreeMap::new();
    tiers.insert(
        "20".to_string(),
        TierEntry {
            product_selector_type: SelectorType::VariantId,
            targets: vec![111],
            min_qty: None,
        },
    );
    TierConfig {
        message: None,
        apply_to: ApplyTo::Price,
        discount_type: DiscountType::Percentage,
        selection_strategy: SelectionStrategy::All,
        platform: PlatformCfg::Both,
        discount_tiers: tiers,
    }
}

#[test]
fn empty_cart_yields_no_candidates() {
    assert!(build_candidates(&tier_cfg(), &[]).is_empty());
}

#[test]
fn no_tiers_yields_no_candidates() {
    let cfg = TierConfig::default(); // empty discount_tiers
    let lines = vec![Line {
        id: "l1".into(),
        quantity: 3,
        variant_id: Some(111),
        product_id: Some(10),
        subtotal: 150.0,
        amount_per_qty: 50.0,
        compare_at_per_qty: None,
    }];
    assert!(build_candidates(&cfg, &lines).is_empty());
}

#[test]
fn null_or_oversized_config_parses_to_none() {
    // A >10KB metafield is returned to the function as null; null/empty → None → no ops.
    assert!(parse_tier_config(None).is_none());
    assert!(parse_tier_config(Some("   ")).is_none());
}

#[test]
fn no_matching_lines_yields_no_candidates() {
    let cfg = tier_cfg(); // targets variant 111
    let lines = vec![Line {
        id: "l1".into(),
        quantity: 1,
        variant_id: Some(999),
        product_id: Some(88),
        subtotal: 50.0,
        amount_per_qty: 50.0,
        compare_at_per_qty: None,
    }];
    assert!(build_candidates(&cfg, &lines).is_empty());
}
