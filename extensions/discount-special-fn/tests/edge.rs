use discount_special::config::{parse_special_config, PlatformCfg, SpecialConfig};
use discount_special::engine::{build_candidates, Line};

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
    assert!(parse_special_config(None).is_none());
    assert!(parse_special_config(Some("")).is_none());
    assert!(parse_special_config(Some("nope")).is_none());
}

#[test]
fn no_rules_yields_no_candidates() {
    let cfg = SpecialConfig::default();
    assert!(build_candidates(&cfg, &[line("l1", 1, 111, 10.0)], PlatformCfg::Checkout).is_empty());
}

#[test]
fn fixed_ratio_zero_pool_keeps_source_drops_targets() {
    // total target qty 2, target_per_source 3 → targetExact 0 → sharedPool 0 → groups skipped,
    // but the source candidate is still emitted.
    let cfg = parse_special_config(Some(
        "{\"special_discounts\":[{\"source_variants\":[111],\"source_operator\":\"percentage\",\"source_value\":10,\"source_message\":\"Source\",\"quantity_dependent\":true,\"fixed_ratio\":true,\"min_qty\":1,\"target_per_source\":3,\"targets\":[{\"target_variants\":[222],\"target_operator\":\"percentage\",\"target_value\":20,\"target_message\":\"G1\"},{\"target_variants\":[333],\"target_operator\":\"percentage\",\"target_value\":15,\"target_message\":\"G2\"}]}]}",
    ))
    .unwrap();
    let lines = vec![
        line("src", 1, 111, 100.0),
        line("t1", 1, 222, 50.0),
        line("t2", 1, 333, 60.0),
    ];
    let out = build_candidates(&cfg, &lines, PlatformCfg::Checkout);
    assert_eq!(out.len(), 1, "source only, got {out:?}");
    assert_eq!(out[0].target_ids, vec!["src".to_string()]);
}
