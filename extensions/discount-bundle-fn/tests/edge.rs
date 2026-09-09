use discount_bundle::config::{parse_bundle_config, BundleConfig, PlatformCfg};
use discount_bundle::engine::{build_candidates, Line};

fn line(id: &str, qty: u32, variant: i64, price: f64) -> Line {
    Line {
        id: id.into(),
        quantity: qty,
        variant_id: Some(variant),
        product_id: Some(1),
        subtotal: price * qty as f64,
        amount_per_qty: price,
        compare_at_per_qty: None,
    }
}

#[test]
fn empty_config_is_fail_safe() {
    assert!(parse_bundle_config(None).is_none());
    assert!(parse_bundle_config(Some("")).is_none());
    assert!(parse_bundle_config(Some("garbage")).is_none());
}

#[test]
fn no_bundles_yields_no_candidates() {
    let cfg = BundleConfig::default();
    let out = build_candidates(&cfg, &[line("l1", 1, 100, 10.0)], PlatformCfg::Checkout);
    assert!(out.candidates.is_empty());
}

#[test]
fn fixed_ratio_zero_pool_skips_whole_bundle() {
    // max_target_qty <= target_per_source → maxDiscountQty 0 → skip (no message leak).
    let cfg = parse_bundle_config(Some(
        "{\"bundle_discounts\":[{\"source_variants\":[100],\"target_variants\":[300],\"operator\":\"percentage\",\"value\":20,\"message\":\"X\",\"quantity_dependent\":true,\"target_per_source\":2,\"min_qty\":1,\"fixed_ratios\":true,\"max_target_qty\":2}]}",
    ))
    .unwrap();
    let lines = vec![line("src", 1, 100, 10.0), line("tgt", 6, 300, 50.0)];
    let out = build_candidates(&cfg, &lines, PlatformCfg::Checkout);
    assert!(out.candidates.is_empty(), "got {:?}", out.candidates);
}

#[test]
fn missing_source_or_target_skips() {
    let cfg = parse_bundle_config(Some(
        "{\"bundle_discounts\":[{\"source_variants\":[100],\"target_variants\":[300],\"operator\":\"percentage\",\"value\":20,\"message\":\"X\"}]}",
    ))
    .unwrap();
    // only source present, no target line
    let out = build_candidates(&cfg, &[line("src", 1, 100, 10.0)], PlatformCfg::Checkout);
    assert!(out.candidates.is_empty());
}
