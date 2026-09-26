//! Pass 1 — bundle expansion. Ported behaviour-faithfully from
//! `eva/discount-engine`'s `bundle-expander.js`.
//!
//! A cart line whose variant carries a `bundle.composition_v2` metafield is
//! expanded into its component line items. Each component is priced at a
//! fixed price per unit, *unless* the bundle line has already been
//! discounted (its composition-derived price exceeds the line's current
//! subtotal), in which case the price adjustment is omitted so Shopify
//! distributes the discounted total proportionally. Every component is
//! stamped with a `_Bundle` attribute set to the parent product's title.

use crate::config::BundleComponent;
use crate::config::CompositionConfig;
use crate::shared::{format_num, CartLine, ExpandedItemOut, LineExpandOp};

/// Mirrors JS `BundleExpander.canExpand`.
pub fn can_expand(line: &CartLine) -> bool {
    line.is_product_variant && line.composition.is_some()
}

/// Mirrors JS `BundleExpander.expand`.
///
/// Returns:
///  - `None` if the line isn't a `composition_v2` bundle (not handled by this pass).
///  - `Some(Err(..))` if the line *is* a bundle but its composition metafield
///    is invalid JSON or an empty array — mirrors JS throwing
///    `Error("Invalid bundle composition on line ...")`, which aborts the
///    whole Function invocation.
///  - `Some(Ok(op))` with the expansion operation otherwise.
pub fn expand(line: &CartLine) -> Option<Result<LineExpandOp, String>> {
    if !can_expand(line) {
        return None;
    }

    let composition_raw = line.composition.as_deref().unwrap();
    let config: CompositionConfig = match serde_json::from_str(composition_raw) {
        Ok(c) => c,
        Err(e) => {
            return Some(Err(format!("Invalid bundle composition on line {}: {}", line.id, e)));
        }
    };
    let composition: Vec<BundleComponent> = config.components().to_vec();
    if composition.is_empty() {
        return Some(Err(format!("Invalid bundle composition on line {}", line.id)));
    }

    let bundle_price: f64 = composition.iter().map(|c| c.price * c.quantity as f64).sum();
    let subtotal: f64 = line
        .subtotal_amount
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let is_discounted = bundle_price > subtotal;

    // Operation-level target price, when the merchant set one.
    //
    // Shopify bases a `lineExpand` adjustment on the BUNDLE PRODUCT price —
    // not the components' sum, which is what `linesMerge` uses — so the
    // percentage is computed against this line's own subtotal. `PriceAdjustment`
    // exposes only `percentageDecrease`, so a target at or above what the
    // bundle product already costs has no representation and is ignored rather
    // than silently inverted into a surcharge.
    let percentage_decrease = config.target_price().and_then(|target| {
        if subtotal <= 0.0 || target >= subtotal {
            return None;
        }
        Some(((1.0 - target / subtotal) * 100.0).clamp(0.0, 100.0))
    });

    let bundle_title = line.product_title.clone().unwrap_or_default();

    let expanded_items = composition
        .into_iter()
        .map(|c| ExpandedItemOut {
            merchandise_id: c.id,
            quantity: c.quantity,
            attributes: vec![("_Bundle".to_string(), bundle_title.clone())],
            price_amount: if is_discounted { None } else { Some(format_num(c.price)) },
        })
        .collect();

    Some(Ok(LineExpandOp {
        cart_line_id: line.id.clone(),
        expanded_items,
        title: None,
        percentage_decrease,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle_line(composition_json: &str, subtotal: &str) -> CartLine {
        CartLine {
            id: "gid://shopify/CartLine/bundle-1".to_string(),
            is_product_variant: true,
            variant_gid: Some("gid://shopify/ProductVariant/111".to_string()),
            variant_id: Some(111),
            product_title: Some("Test Bundle".to_string()),
            composition: Some(composition_json.to_string()),
            amount_per_quantity: Some(subtotal.to_string()),
            subtotal_amount: Some(subtotal.to_string()),
            quantity: 1,
        }
    }

    // ─── operation-level target price ──────────────────────────────────────
    //
    // Shopify bases a lineExpand adjustment on the BUNDLE PRODUCT price, not
    // the components' sum (which is what linesMerge uses). `PriceAdjustment`
    // offers only `percentageDecrease`, so the target is expressed as a
    // percentage off this line's own subtotal.

    const WITH_PRICE: &str = r#"{"price":80.0,"components":[
        {"id":"gid://shopify/ProductVariant/1","quantity":1,"price":60.0},
        {"id":"gid://shopify/ProductVariant/2","quantity":1,"price":40.0}]}"#;

    #[test]
    fn target_price_becomes_a_percentage_off_the_bundle_product_price() {
        // Bundle product costs 100; the merchant wants 80 -> 20% off.
        let op = expand(&bundle_line(WITH_PRICE, "100.00")).unwrap().unwrap();
        let pct = op.percentage_decrease.expect("a target price must produce an adjustment");
        assert!((pct - 20.0).abs() < 1e-9, "expected 20%, got {pct}");
    }

    #[test]
    fn a_target_at_or_above_the_bundle_product_price_is_ignored() {
        // percentageDecrease cannot raise a price, and a negative percentage
        // would silently invert into a surcharge. Emitting nothing leaves the
        // line at what the bundle product already costs.
        for subtotal in ["80.00", "50.00"] {
            let op = expand(&bundle_line(WITH_PRICE, subtotal)).unwrap().unwrap();
            assert_eq!(op.percentage_decrease, None, "subtotal {subtotal} should not adjust");
        }
    }

    #[test]
    fn a_zero_subtotal_produces_no_adjustment_rather_than_dividing_by_zero() {
        let op = expand(&bundle_line(WITH_PRICE, "0.00")).unwrap().unwrap();
        assert_eq!(op.percentage_decrease, None);
    }

    #[test]
    fn a_bare_component_array_still_parses_and_sets_no_adjustment() {
        // The metafield shape before the price field existed. A bundle saved
        // then must keep working untouched until it is next saved.
        let legacy = r#"[{"id":"gid://shopify/ProductVariant/1","quantity":2,"price":10.0}]"#;
        let op = expand(&bundle_line(legacy, "100.00")).unwrap().unwrap();
        assert_eq!(op.percentage_decrease, None);
        assert_eq!(op.expanded_items.len(), 1);
        assert_eq!(op.expanded_items[0].quantity, 2);
    }

    #[test]
    fn non_bundle_line_is_not_expanded() {
        let mut line = bundle_line("[]", "10.00");
        line.composition = None;
        assert!(!can_expand(&line));
        assert!(expand(&line).is_none());
    }

    #[test]
    fn non_product_variant_is_not_expanded() {
        let mut line = bundle_line(r#"[{"id":"gid://shopify/ProductVariant/222","quantity":1,"price":10}]"#, "10.00");
        line.is_product_variant = false;
        assert!(expand(&line).is_none());
    }

    #[test]
    fn expands_into_components_with_fixed_price() {
        let line = bundle_line(r#"[{"id":"gid://shopify/ProductVariant/222","quantity":1,"price":10}]"#, "10.00");
        let op = expand(&line).unwrap().unwrap();
        assert_eq!(op.cart_line_id, line.id);
        assert_eq!(op.expanded_items.len(), 1);
        assert_eq!(op.expanded_items[0].merchandise_id, "gid://shopify/ProductVariant/222");
        assert_eq!(op.expanded_items[0].price_amount.as_deref(), Some("10"));
        assert_eq!(
            op.expanded_items[0].attributes,
            vec![("_Bundle".to_string(), "Test Bundle".to_string())]
        );
    }

    #[test]
    fn discounted_bundle_omits_price_adjustment() {
        // Composition sums to 20.00 but the line's current subtotal is only 10.00
        // (already discounted) -> price omitted, Shopify distributes proportionally.
        let line = bundle_line(
            r#"[{"id":"gid://shopify/ProductVariant/222","quantity":2,"price":10}]"#,
            "10.00",
        );
        let op = expand(&line).unwrap().unwrap();
        assert_eq!(op.expanded_items[0].price_amount, None);
    }

    #[test]
    fn empty_composition_is_an_error() {
        let line = bundle_line("[]", "10.00");
        let result = expand(&line).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn invalid_json_is_an_error() {
        let line = bundle_line("not json", "10.00");
        let result = expand(&line).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn multiple_components() {
        let line = bundle_line(
            r#"[
                {"id":"gid://shopify/ProductVariant/222","quantity":1,"price":10},
                {"id":"gid://shopify/ProductVariant/333","quantity":2,"price":5.5}
            ]"#,
            "50.00",
        );
        let op = expand(&line).unwrap().unwrap();
        assert_eq!(op.expanded_items.len(), 2);
        assert_eq!(op.expanded_items[1].quantity, 2);
        assert_eq!(op.expanded_items[1].price_amount.as_deref(), Some("5.5"));
    }
}
