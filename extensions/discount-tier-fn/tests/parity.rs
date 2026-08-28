//! JS→Rust parity: assert the Rust engine reproduces the operations the eva
//! JS `tier_discount.js` handler emits, using ground-truth cases extracted from
//! eva's `tier_discount.test.js`. Expected values come from the JS test, never
//! hand-fabricated.

use discount_tier::config::parse_tier_config;
use discount_tier::engine::{build_candidates, DiscountValue, Line};
use discount_tier::shared::id_from_gid;
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
        .map(|l| {
            let variant_id = l["variantGid"].as_str().and_then(id_from_gid);
            let product_id = l["productGid"].as_str().and_then(id_from_gid);
            let amount_per_qty: f64 = l["amountPerQuantity"].as_str().unwrap().parse().unwrap();
            let subtotal: f64 = l["subtotal"].as_str().unwrap().parse().unwrap();
            let compare_at_per_qty = l["compareAt"].as_str().and_then(|s| s.parse().ok());
            Line {
                id: l["id"].as_str().unwrap().to_string(),
                quantity: l["quantity"].as_u64().unwrap() as u32,
                variant_id,
                product_id,
                subtotal,
                amount_per_qty,
                compare_at_per_qty,
            }
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
    let cfg = parse_tier_config(input["config"].as_str()).expect("config parses");
    let lines = lines_from(&input);
    let candidates = build_candidates(&cfg, &lines);

    let got: Vec<Value> = candidates
        .iter()
        .map(|c| {
            json!({
                "message": c.message,
                "targets": c.target_ids,
                "value": value_json(&c.value),
            })
        })
        .collect();

    let want = expected["candidates"].as_array().unwrap();
    assert_eq!(got.len(), want.len(), "[{name}] candidate count");
    for (i, (g, e)) in got.iter().zip(want).enumerate() {
        assert_eq!(g, e, "[{name}] candidate {i} mismatch");
    }
}

#[test]
fn parity_percentage_all() {
    run("tier_percentage_all");
}

#[test]
fn parity_maximum() {
    run("tier_maximum");
}

#[test]
fn parity_compare_at_amount() {
    run("tier_compare_at_amount");
}
