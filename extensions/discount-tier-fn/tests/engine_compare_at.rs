use discount_tier::config::*;
use discount_tier::engine::*;
use std::collections::BTreeMap;

fn cfg(dt: DiscountType) -> TierConfig {
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
        apply_to: ApplyTo::CompareAtPrice,
        discount_type: dt,
        selection_strategy: SelectionStrategy::All,
        platform: PlatformCfg::Both,
        discount_tiers: tiers,
    }
}

fn line(id: &str, qty: u32, price: f64, compare_at: Option<f64>) -> Line {
    Line {
        id: id.into(),
        quantity: qty,
        variant_id: Some(111),
        product_id: Some(10),
        subtotal: price * qty as f64,
        amount_per_qty: price,
        compare_at_per_qty: compare_at,
    }
}

#[test]
fn percentage_off_compare_at_yields_string_fixed_amount() {
    // compareAt=120, current=80, 20% off compareAt → desiredFinal=96;
    // per-item discount = max(0, 80-96) = 0 → total "0"
    let c = build_candidates(&cfg(DiscountType::Percentage), &[line("l1", 2, 80.0, Some(120.0))]);
    assert_eq!(c.len(), 1);
    match &c[0].value {
        DiscountValue::FixedAmountStr(s) => assert_eq!(s, "0"),
        _ => panic!("expected string fixedAmount"),
    }
}

#[test]
fn skips_line_when_compare_at_below_current() {
    let c = build_candidates(&cfg(DiscountType::Percentage), &[line("l1", 1, 80.0, Some(50.0))]);
    assert!(c.is_empty()); // compareAt(50) < current(80) → skip
}

#[test]
fn amount_type_is_min_of_value_and_current_times_qty() {
    // amount 20, current 80, qty 2 → per-item min(20,80)=20 → total 40 → "40"
    let c = build_candidates(&cfg(DiscountType::Amount), &[line("l1", 2, 80.0, Some(120.0))]);
    match &c[0].value {
        DiscountValue::FixedAmountStr(s) => assert_eq!(s, "40"),
        _ => panic!("expected string fixedAmount"),
    }
}

#[test]
fn missing_compare_at_falls_back_to_selling_price() {
    // compareAt None → fallback = current(80); percentage 20% → desiredFinal 64;
    // discount per item 16; qty 1 → "16"
    let c = build_candidates(&cfg(DiscountType::Percentage), &[line("l1", 1, 80.0, None)]);
    match &c[0].value {
        DiscountValue::FixedAmountStr(s) => assert_eq!(s, "16"),
        _ => panic!("expected string fixedAmount"),
    }
}
