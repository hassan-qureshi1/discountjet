//! JS→Rust parity for the special engine, using ground-truth values from eva's
//! `special_discount.test.js`.

use discount_special::config::{parse_special_config, PlatformCfg};
use discount_special::engine::{build_candidates, DiscountValue, Line};
use discount_special::shared::id_from_gid;
use serde_json::{json, Value};

fn load(name: &str) -> (Value, Value) {
    let input: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("tests/fixtures/{name}.input.json")).unwrap(),
    )
    .unwrap();
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("tests/fixtures/{name}.expected.json")).unwrap(),
    )
    .unwrap();
    (input, expected)
}

fn lines_from(input: &Value) -> Vec<Line> {
    input["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| Line {
            id: l["id"].as_str().unwrap().to_string(),
            quantity: l["quantity"].as_u64().unwrap() as u32,
            variant_id: l["variantGid"].as_str().and_then(id_from_gid),
            product_id: l["productGid"].as_str().and_then(id_from_gid),
            subtotal: l["subtotal"].as_str().unwrap().parse().unwrap(),
            amount_per_qty: l["amountPerQuantity"].as_str().unwrap().parse().unwrap(),
            compare_at_per_qty: l["compareAt"].as_str().and_then(|s| s.parse().ok()),
        })
        .collect()
}

fn value_json(v: &DiscountValue) -> Value {
    match v {
        DiscountValue::Percentage(n) => json!({ "percentage": n }),
        DiscountValue::FixedAmountNum(n) => json!({ "fixedAmountNum": n }),
        DiscountValue::FixedAmountStr(s) => json!({ "fixedAmountStr": s }),
    }
}

fn run(name: &str) {
    let (input, expected) = load(name);
    let cfg = parse_special_config(input["config"].as_str()).expect("config parses");
    let lines = lines_from(&input);
    let candidates = build_candidates(&cfg, &lines, PlatformCfg::Checkout);
    let got: Vec<Value> = candidates
        .iter()
        .map(|c| json!({ "message": c.message, "targets": c.target_ids, "value": value_json(&c.value) }))
        .collect();
    let want = expected["candidates"].as_array().unwrap();
    assert_eq!(got.len(), want.len(), "[{name}] candidate count: got {got:?}");
    for (i, (g, e)) in got.iter().zip(want).enumerate() {
        assert_eq!(g, e, "[{name}] candidate {i}");
    }
}

#[test]
fn parity_legacy_single() {
    run("special_legacy_single");
}

#[test]
fn parity_maximum() {
    run("special_maximum");
}

#[test]
fn parity_fixed_ratio_cross() {
    run("special_fixed_ratio_cross");
}
