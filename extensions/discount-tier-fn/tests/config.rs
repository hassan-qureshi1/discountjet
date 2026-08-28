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
