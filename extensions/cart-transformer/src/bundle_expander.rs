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
    let composition: Vec<BundleComponent> = match serde_json::from_str(composition_raw) {
        Ok(c) => c,
        Err(e) => {
            return Some(Err(format!("Invalid bundle composition on line {}: {}", line.id, e)));
        }
    };
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

    Some(Ok(LineExpandOp { cart_line_id: line.id.clone(), expanded_items, title: None }))
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
        }
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
