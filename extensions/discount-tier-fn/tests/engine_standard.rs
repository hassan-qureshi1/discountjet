use discount_tier::config::*;
use discount_tier::engine::*;
use std::collections::BTreeMap;

fn line(id: &str, qty: u32, variant: i64, product: i64, price: f64) -> Line {
    Line {
        id: id.into(),
        quantity: qty,
        variant_id: Some(variant),
        product_id: Some(product),
        subtotal: price * qty as f64,
        amount_per_qty: price,
        compare_at_per_qty: None,
    }
}

fn cfg_with(strategy: SelectionStrategy, min_qty: Option<u32>) -> TierConfig {
    let mut tiers = BTreeMap::new();
    tiers.insert(
        "20".to_string(),
        TierEntry {
            product_selector_type: SelectorType::VariantId,
            targets: vec![111],
            min_qty,
        },
    );
    TierConfig {
        message: Some("FLASH".into()),
        apply_to: ApplyTo::Price,
        discount_type: DiscountType::Percentage,
        selection_strategy: strategy,
        platform: PlatformCfg::Both,
        discount_tiers: tiers,
    }
}

#[test]
fn all_eligible_lines_get_percentage_and_message() {
    let cfg = cfg_with(SelectionStrategy::All, None);
    let lines = vec![line("l1", 1, 111, 10, 50.0), line("l2", 1, 999, 20, 80.0)];
    let c = build_candidates(&cfg, &lines);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].target_ids, vec!["l1"]); // only variant 111 matches
    assert_eq!(c[0].message, "FLASH 20% OFF");
    assert!(matches!(c[0].value, DiscountValue::Percentage(v) if (v - 20.0).abs() < 1e-9));
}

#[test]
fn per_line_min_qty_excludes_below_threshold() {
    let cfg = cfg_with(SelectionStrategy::All, Some(2));
    let lines = vec![line("l1", 1, 111, 10, 50.0)]; // qty 1 < min_qty 2
    assert!(build_candidates(&cfg, &lines).is_empty());
}

#[test]
fn maximum_picks_highest_subtotal_line() {
    let cfg = {
        let mut c = cfg_with(SelectionStrategy::Maximum, None);
        c.discount_tiers.get_mut("20").unwrap().targets = vec![111, 222];
        c
    };
    let lines = vec![line("small", 1, 111, 10, 10.0), line("big", 1, 222, 20, 90.0)];
    let c = build_candidates(&cfg, &lines);
    assert_eq!(c[0].target_ids, vec!["big"]);
}

#[test]
fn message_without_prefix_is_bare_percent_off() {
    let mut cfg = cfg_with(SelectionStrategy::All, None);
    cfg.message = None;
    let lines = vec![line("l1", 1, 111, 10, 50.0)];
    let c = build_candidates(&cfg, &lines);
    assert_eq!(c[0].message, "20% OFF");
}

#[test]
fn amount_type_emits_fixed_amount_number() {
    let mut cfg = cfg_with(SelectionStrategy::All, None);
    cfg.discount_type = DiscountType::Amount;
    let lines = vec![line("l1", 1, 111, 10, 50.0)];
    let c = build_candidates(&cfg, &lines);
    assert!(matches!(c[0].value, DiscountValue::FixedAmountNum(v) if (v - 20.0).abs() < 1e-9));
}
