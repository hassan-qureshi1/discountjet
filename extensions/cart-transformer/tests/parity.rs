//! JS -> Rust parity for the cart transform function, using ground-truth
//! values and configs lifted directly from eva's
//! `cart-transformer/tests/cart_transformation.test.js` (782 lines).
//!
//! Unlike the per-module unit tests (which exercise individual pure
//! functions), these tests run the *full* pipeline — config JSON parsing,
//! bundle expansion, and config-driven transformation together via
//! `orchestrator::transform` — mirroring what `cartTransformRun` does in JS
//! once you factor out the thin Shopify Input/Output adapter (which is
//! tested for real by the wasm build; this crate's tests exercise the
//! Shopify-independent logic it delegates to).

use cart_transformer::config::{parse_discount_engine_config, parse_merge_bundle_config};
use cart_transformer::orchestrator;
use cart_transformer::shared::{has_priority_discount_code, id_from_gid, CartLine, CartOp};

fn variant_gid(id: i64) -> String {
    format!("gid://shopify/ProductVariant/{id}")
}

fn line(variant_id: i64, line_id: &str, price: &str) -> CartLine {
    CartLine {
        id: line_id.to_string(),
        is_product_variant: true,
        variant_gid: Some(variant_gid(variant_id)),
        variant_id: Some(variant_id),
        product_title: None,
        composition: None,
        amount_per_quantity: Some(price.to_string()),
        subtotal_amount: Some(price.to_string()),
        quantity: 1,
    }
}

// Verbatim (field-for-field) port of the JS test file's CONFIG_ANY / CONFIG_ALL
// fixtures, expressed as the raw JSON the shop's `checkout.discount_engine`
// metafield would actually contain.
const CONFIG_ANY_JSON: &str = r#"{
    "title": "hassan",
    "message": [{ "key": "test", "value": "hassan" }],
    "apply_to_message": "source",
    "platform_source": "BOTH",
    "target_quantity": 1,
    "source_variants": [48121306906908, 48121306939676, 48121306972444, 48121307005212, 48121307037980],
    "target_variants": [{ "id": 48121307529500, "price": "109.00", "compareAtPrice": "149.00" }],
    "condition": "ANY",
    "value": 50,
    "operator": "%"
}"#;

const CONFIG_ALL_JSON: &str = r#"{
    "title": "ghhmgjm",
    "message": [],
    "apply_to_message": "source",
    "platform_source": "BOTH",
    "target_quantity": 1,
    "source_variants": [48121306906908, 48121306939676],
    "target_variants": [{ "id": 48121307529500, "price": "109.00", "compareAtPrice": "149.00" }],
    "condition": "ALL",
    "value": 10,
    "operator": "%"
}"#;

fn parse_one(json: &str) -> cart_transformer::config::EngineConfig {
    let mut cfgs = parse_discount_engine_config(Some(json));
    assert_eq!(cfgs.len(), 1, "expected exactly one config to parse");
    cfgs.remove(0)
}

// ── getVariantId ─────────────────────────────────────────────────────────

#[test]
fn get_variant_id_extracts_numeric_id_from_gid() {
    assert_eq!(id_from_gid(&variant_gid(48121306906908)), Some(48121306906908));
}

// ── transform (full pipeline): CONFIG_ANY ───────────────────────────────

#[test]
fn config_any_processes_matching_cart_line() {
    let lines = vec![line(48121306906908, "line_A", "79.99")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = orchestrator::transform(&lines, &configs, &[], None).unwrap();
    assert_eq!(ops.len(), 1);
    let op = ops[0].as_expand();
    assert_eq!(op.cart_line_id, "line_A");
    assert_eq!(op.title.as_deref(), Some("hassan"));
    // source + 1 target
    assert_eq!(op.expanded_items.len(), 2);
    // 109.00 - 50% = 54.50
    assert_eq!(op.expanded_items[1].price_amount.as_deref(), Some("54.50"));
    assert_eq!(op.expanded_items[1].merchandise_id, variant_gid(48121307529500));
}

#[test]
fn config_any_operator_minus() {
    // Mirrors the JS test overriding operator/value: 109.00 - 9 = 100.00.
    let json = CONFIG_ANY_JSON.replace(r#""operator": "%""#, r#""operator": "-""#).replace(
        r#""value": 50"#,
        r#""value": 9"#,
    );
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(&json)];
    let ops = orchestrator::transform(&lines, &configs, &[], None).unwrap();
    assert_eq!(ops[0].as_expand().expanded_items[1].price_amount.as_deref(), Some("100.00"));
}

// ── transform (full pipeline): CONFIG_ALL ───────────────────────────────

#[test]
fn config_all_requires_both_source_variants_present() {
    let lines = vec![line(48121306906908, "line_A", "79.99"), line(48121306939676, "line_B", "89.99")];
    let configs = vec![parse_one(CONFIG_ALL_JSON)];
    let ops = orchestrator::transform(&lines, &configs, &[], None).unwrap();
    assert_eq!(ops.len(), 1);
}

#[test]
fn config_all_no_operation_when_only_one_source_present() {
    let lines = vec![line(48121306906908, "line_A", "79.99")];
    let configs = vec![parse_one(CONFIG_ALL_JSON)];
    let ops = orchestrator::transform(&lines, &configs, &[], None).unwrap();
    assert!(ops.is_empty());
}

#[test]
fn both_configs_together_produce_two_operations() {
    let lines = vec![line(48121306906908, "line_A", "79.99"), line(48121306939676, "line_B", "89.99")];
    let configs = vec![parse_one(CONFIG_ANY_JSON), parse_one(CONFIG_ALL_JSON)];
    let ops = orchestrator::transform(&lines, &configs, &[], None).unwrap();
    // CONFIG_ANY claims line_A; CONFIG_ALL then claims line_B (next available source).
    assert_eq!(ops.len(), 2);
    let ids: Vec<_> = ops.iter().map(|o| o.as_expand().cart_line_id.as_str()).collect();
    assert!(ids.contains(&"line_A"));
}

#[test]
fn same_source_line_not_expanded_twice_across_configs() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let cfg = parse_one(CONFIG_ANY_JSON);
    let ops = orchestrator::transform(&lines, &[cfg.clone(), cfg], &[], None).unwrap();
    assert_eq!(ops.len(), 1);
}

#[test]
fn inactive_config_is_skipped() {
    let json = CONFIG_ANY_JSON.replacen('{', "{\"active\": false, ", 1);
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(&json)];
    assert!(orchestrator::transform(&lines, &configs, &[], None).unwrap().is_empty());
}

#[test]
fn platform_source_mismatch_skips_config() {
    let json = CONFIG_ANY_JSON.replace(r#""platform_source": "BOTH""#, r#""platform_source": "CHECKOUT""#);
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(&json)];
    let ops = orchestrator::transform(&lines, &configs, &[], Some("POS")).unwrap();
    assert!(ops.is_empty());
}

#[test]
fn pos_cart_with_both_platform_config_still_produces_operations() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = orchestrator::transform(&lines, &configs, &[], Some("POS")).unwrap();
    assert_eq!(ops.len(), 1);
}

#[test]
fn empty_cart_produces_no_operations_regardless_of_configs() {
    let configs = vec![parse_one(CONFIG_ANY_JSON), parse_one(CONFIG_ALL_JSON)];
    assert!(orchestrator::transform(&[], &configs, &[], None).unwrap().is_empty());
}

#[test]
fn multiple_target_variants_per_config() {
    let json = CONFIG_ANY_JSON.replace(
        r#""target_variants": [{ "id": 48121307529500, "price": "109.00", "compareAtPrice": "149.00" }]"#,
        r#""target_variants": [
            { "id": 111, "price": "50.00" },
            { "id": 222, "price": "60.00" },
            { "id": 333, "price": "70.00" }
        ]"#,
    );
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(&json)];
    let ops = orchestrator::transform(&lines, &configs, &[], None).unwrap();
    assert_eq!(ops[0].as_expand().expanded_items.len(), 4); // 1 source + 3 targets
}

// ── cartTransformRun: priority discount code guard ──────────────────────
// These mirror `describe('cartTransformRun – priority discount', ...)`,
// composing the pure `has_priority_discount_code` guard with the pipeline —
// exactly what the adapter's `cart_transform_run` does before delegating.

fn run_full(
    cart_code: Option<&str>,
    priority_codes_raw: Option<&str>,
    lines: &[CartLine],
    configs: &[cart_transformer::config::EngineConfig],
) -> Vec<CartOp> {
    if has_priority_discount_code(cart_code, priority_codes_raw) {
        return vec![];
    }
    if lines.is_empty() {
        return vec![];
    }
    orchestrator::transform(lines, configs, &[], None).unwrap()
}

#[test]
fn priority_code_exact_suppresses_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(
        Some("PRIORITY50"),
        Some(r#"[{"code":"PRIORITY50","selector":"exact"}]"#),
        &lines,
        &configs,
    );
    assert!(ops.is_empty());
}

#[test]
fn priority_code_prefix_suppresses_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(
        Some("PRIORITY2024"),
        Some(r#"[{"code":"PRIORITY","selector":"prefix"}]"#),
        &lines,
        &configs,
    );
    assert!(ops.is_empty());
}

#[test]
fn priority_code_suffix_suppresses_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(Some("FLASHSALE"), Some(r#"[{"code":"SALE","selector":"suffix"}]"#), &lines, &configs);
    assert!(ops.is_empty());
}

#[test]
fn non_matching_discount_code_still_applies_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(
        Some("REGULAR10"),
        Some(r#"[{"code":"PRIORITY","selector":"prefix"}]"#),
        &lines,
        &configs,
    );
    assert_eq!(ops.len(), 1);
}

#[test]
fn no_discount_code_still_applies_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(None, Some(r#"[{"code":"PRIORITY","selector":"exact"}]"#), &lines, &configs);
    assert_eq!(ops.len(), 1);
}

#[test]
fn missing_priority_codes_metafield_still_applies_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(Some("PRIORITY50"), None, &lines, &configs);
    assert_eq!(ops.len(), 1);
}

#[test]
fn empty_priority_codes_array_still_applies_transformation() {
    let lines = vec![line(48121306906908, "line_A", "1")];
    let configs = vec![parse_one(CONFIG_ANY_JSON)];
    let ops = run_full(Some("PRIORITY50"), Some("[]"), &lines, &configs);
    assert_eq!(ops.len(), 1);
}

// ── cartTransformRun: bundles run even without shop discount_engine config ─
// Mirrors `describe('cartTransformRun – bundles without shop config', ...)`.

fn bundle_only_line(subtotal: &str) -> CartLine {
    CartLine {
        id: "gid://shopify/CartLine/bundle-1".to_string(),
        is_product_variant: true,
        variant_gid: Some(variant_gid(111)),
        variant_id: Some(111),
        product_title: Some("Test Bundle".to_string()),
        composition: Some(r#"[{"id":"gid://shopify/ProductVariant/222","quantity":1,"price":10}]"#.to_string()),
        amount_per_quantity: Some(subtotal.to_string()),
        subtotal_amount: Some(subtotal.to_string()),
        quantity: 1,
    }
}

#[test]
fn bundle_expands_when_shop_metafield_missing() {
    let lines = vec![bundle_only_line("10.00")];
    let configs = parse_discount_engine_config(None); // missing shop metafield
    let ops = run_full(None, None, &lines, &configs);
    assert_eq!(ops.len(), 1);
    let op = ops[0].as_expand();
    assert_eq!(op.cart_line_id, "gid://shopify/CartLine/bundle-1");
    assert_eq!(op.expanded_items[0].merchandise_id, "gid://shopify/ProductVariant/222");
}

#[test]
fn bundle_expands_when_shop_config_is_legacy_placeholder() {
    let lines = vec![bundle_only_line("10.00")];
    let configs = parse_discount_engine_config(Some("[{}]"));
    let ops = run_full(None, None, &lines, &configs);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].as_expand().cart_line_id, "gid://shopify/CartLine/bundle-1");
}

#[test]
fn no_lines_and_no_shop_config_yields_no_operations() {
    let configs = parse_discount_engine_config(None);
    let ops = run_full(None, None, &[], &configs);
    assert!(ops.is_empty());
}

#[test]
fn non_bundle_line_yields_no_operations_when_shop_config_empty() {
    let lines = vec![line(48121306906908, "line_only", "1")];
    let configs = parse_discount_engine_config(Some("[{}]"));
    let ops = run_full(None, None, &lines, &configs);
    assert!(ops.is_empty());
}

// ── no-operations.json fixture (Shopify CLI function-runner style) ──────
// The fixture describes an empty-ish cart (a line with no merchandise) and
// a shop with no discount_engine config; expects zero operations.

#[test]
fn no_operations_fixture_yields_empty_operations() {
    let raw = std::fs::read_to_string("tests/fixtures/no-operations.json").unwrap();
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let payload = &json["payload"];

    let lines: Vec<CartLine> = payload["input"]["cart"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| CartLine {
            id: l["id"].as_str().unwrap().to_string(),
            is_product_variant: false,
            variant_gid: None,
            variant_id: None,
            product_title: None,
            composition: None,
            amount_per_quantity: None,
            subtotal_amount: None,
            quantity: 1,
        })
        .collect();

    let configs = parse_discount_engine_config(None);
    let ops = run_full(None, None, &lines, &configs);

    let expected_ops = payload["output"]["operations"].as_array().unwrap();
    assert_eq!(ops.len(), expected_ops.len());
    assert!(ops.is_empty());
}

// ── transform (full pipeline): merge-bundle pass (E6 activation) ────────
// A merge config sourced from the shop `checkout.merge_bundles` metafield
// JSON, exercised end to end through `orchestrator::transform` alongside the
// discount_engine passes, mirroring the style of the CONFIG_ANY/CONFIG_ALL
// tests above.

const MERGE_CONFIG_JSON: &str = r#"[{
    "parentVariantId": "gid://shopify/ProductVariant/999",
    "price": 49.99,
    "sources": ["gid://shopify/ProductVariant/48121306906908", "gid://shopify/ProductVariant/48121306939676"],
    "title": "Merged Bundle"
}]"#;

fn parse_merge(json: &str) -> Vec<cart_transformer::config::MergeBundleConfig> {
    parse_merge_bundle_config(Some(json))
}

#[test]
fn merge_config_fires_when_all_source_variants_present() {
    let lines = vec![line(48121306906908, "line_A", "30.00"), line(48121306939676, "line_B", "40.00")];
    let merge_configs = parse_merge(MERGE_CONFIG_JSON);
    let ops = orchestrator::transform(&lines, &[], &merge_configs, None).unwrap();
    assert_eq!(ops.len(), 1);
    let op = ops[0].as_merge();
    assert_eq!(op.parent_variant_id, "gid://shopify/ProductVariant/999");
    assert_eq!(op.title.as_deref(), Some("Merged Bundle"));
    assert_eq!(op.cart_lines, vec![("line_A".to_string(), 1), ("line_B".to_string(), 1)]);
    // subtotal = 70.00, price = 49.99 -> pct = (1 - 49.99/70) * 100
    assert!((op.percentage_decrease - 28.585_714_285_714_285).abs() < 1e-9);
}

#[test]
fn merge_config_no_op_when_a_source_variant_is_missing() {
    let lines = vec![line(48121306906908, "line_A", "30.00")];
    let merge_configs = parse_merge(MERGE_CONFIG_JSON);
    let ops = orchestrator::transform(&lines, &[], &merge_configs, None).unwrap();
    assert!(ops.is_empty());
}

#[test]
fn merge_config_and_discount_engine_config_coexist() {
    // discount_engine claims a third, unrelated line (its source_variants list
    // is narrowed to just that line's variant, so it can't collide with the
    // merge config's own two source lines); the merge config independently
    // claims line_A and line_B.
    let lines = vec![
        line(48121306906908, "line_A", "30.00"),
        line(48121306939676, "line_B", "40.00"),
        line(48121307037980, "line_C", "79.99"),
    ];
    let json = CONFIG_ANY_JSON.replace(
        r#""source_variants": [48121306906908, 48121306939676, 48121306972444, 48121307005212, 48121307037980]"#,
        r#""source_variants": [48121307037980]"#,
    );
    let configs = vec![parse_one(&json)];
    let merge_configs = parse_merge(MERGE_CONFIG_JSON);
    let ops = orchestrator::transform(&lines, &configs, &merge_configs, None).unwrap();
    assert_eq!(ops.len(), 2);
    let merge_ops: Vec<_> = ops.iter().filter(|o| matches!(o, CartOp::Merge(_))).collect();
    let expand_ops: Vec<_> = ops.iter().filter(|o| matches!(o, CartOp::Expand(_))).collect();
    assert_eq!(merge_ops.len(), 1);
    assert_eq!(expand_ops.len(), 1);
    assert_eq!(expand_ops[0].as_expand().cart_line_id, "line_C");
}
