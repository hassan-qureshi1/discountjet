//! Shared cart-input types and helpers (pure, Shopify-independent).
//! Ported from `eva/discount-engine`'s `getVariantId` / GID-parsing helpers
//! used throughout the JS applier and bundle expander.

/// A single cart line, reduced to the fields both passes (bundle expansion
/// and config-driven transformation) need. Shopify-independent — built by
/// the adapter from the generated query `Input`.
#[derive(Debug, Clone, Default)]
pub struct CartLine {
    pub id: String,
    /// Whether `merchandise.__typename == "ProductVariant"`.
    pub is_product_variant: bool,
    /// `merchandise.id` (the variant GID), when a ProductVariant.
    pub variant_gid: Option<String>,
    /// Numeric id parsed out of `variant_gid`, mirrors JS `getVariantId`.
    pub variant_id: Option<i64>,
    /// `merchandise.product.title`, when a ProductVariant.
    pub product_title: Option<String>,
    /// Raw JSON string of the `bundle.composition_v2` metafield value, if present.
    pub composition: Option<String>,
    /// `cost.amountPerQuantity.amount`.
    pub amount_per_quantity: Option<String>,
    /// `cost.subtotalAmount.amount`.
    pub subtotal_amount: Option<String>,
    /// The cart line's `quantity`. Only consumed by the merge-bundle pass
    /// (`merge_applier`), which needs it to build the `linesMerge` operation's
    /// `cartLines` input.
    pub quantity: i64,
}

/// A single item to place inside a `lineExpand` operation's `expandedCartItems`.
/// Shared output shape for both the bundle expander and the config applier.
#[derive(Debug, Clone, PartialEq)]
pub struct ExpandedItemOut {
    pub merchandise_id: String,
    pub quantity: i64,
    /// Attribute key/value pairs; empty means "no attributes on this item".
    pub attributes: Vec<(String, String)>,
    /// `fixedPricePerUnit` amount as a decimal string; `None` omits the price
    /// adjustment entirely (Shopify then distributes the line's current
    /// discounted total proportionally across the expanded items).
    pub price_amount: Option<String>,
}

/// A single `lineExpand` operation.
#[derive(Debug, Clone, PartialEq)]
pub struct LineExpandOp {
    pub cart_line_id: String,
    pub expanded_items: Vec<ExpandedItemOut>,
    pub title: Option<String>,
    /// Operation-level `price.percentageDecrease`, when the merchant set a
    /// target price for the bundle. `None` leaves the line at whatever the
    /// bundle product itself costs.
    ///
    /// Per Shopify's Cart Transform docs the base differs by operation:
    /// `linesMerge` adjusts against the COMPONENTS' price sum, `lineExpand`
    /// against the BUNDLE PRODUCT price. So this percentage is computed from
    /// the parent line's own subtotal, not from the components.
    pub percentage_decrease: Option<f64>,
}

/// A single `linesMerge` operation. Ported behaviour-faithfully from
/// `eva/discount-engine`'s merge-bundle handling: several cart lines are
/// merged into one, priced down to a configured target total via a
/// percentage-decrease price adjustment.
#[derive(Debug, Clone, PartialEq)]
pub struct LinesMergeOp {
    /// The matched source cart lines to merge, as `(cartLineId, quantity)`.
    pub cart_lines: Vec<(String, i64)>,
    /// The GID of the product variant that represents the merged group.
    pub parent_variant_id: String,
    /// Percentage (0-100) knocked off the merged lines' combined subtotal to
    /// bring it down to the configured target `price`.
    pub percentage_decrease: f64,
    pub title: Option<String>,
}

/// A single operation emitted by the orchestrator. Both existing passes
/// (bundle expansion and the config applier) emit `lineExpand`; the
/// merge-bundle pass emits `linesMerge`. Unified here so `orchestrator::transform`
/// can return one ordered list spanning all three passes.
#[derive(Debug, Clone, PartialEq)]
pub enum CartOp {
    Expand(LineExpandOp),
    Merge(LinesMergeOp),
}

impl CartOp {
    /// Test/parity helper: unwrap the `Expand` variant. Panics if this is a
    /// `Merge` operation — only meant for tests that assert on `lineExpand`
    /// shapes.
    pub fn as_expand(&self) -> &LineExpandOp {
        match self {
            CartOp::Expand(op) => op,
            CartOp::Merge(_) => panic!("expected CartOp::Expand, got CartOp::Merge"),
        }
    }

    /// Test/parity helper: unwrap the `Merge` variant. Panics if this is an
    /// `Expand` operation.
    pub fn as_merge(&self) -> &LinesMergeOp {
        match self {
            CartOp::Merge(op) => op,
            CartOp::Expand(_) => panic!("expected CartOp::Merge, got CartOp::Expand"),
        }
    }
}

/// Extract the trailing numeric id from a GID string, e.g.
/// `"gid://shopify/ProductVariant/12345"` -> `Some(12345)`.
/// Mirrors JS `Number(id.split('/').pop())`: an unparseable id becomes JS
/// `NaN`, which never equals anything (including another `NaN`) — modeled
/// here as `None`, which likewise never matches a config's numeric ids.
pub fn id_from_gid(gid: &str) -> Option<i64> {
    gid.rsplit('/').next()?.parse::<i64>().ok()
}

/// Format an `f64` the way JS `String(number)` does: an integral value has no
/// decimal point, otherwise Rust's default `Display` (shortest round-trip
/// decimal) is used. Used for the bundle expander's `String(component.price)`.
pub fn format_num(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_from_gid_parses_trailing_number() {
        assert_eq!(id_from_gid("gid://shopify/ProductVariant/48121306906908"), Some(48121306906908));
    }

    #[test]
    fn id_from_gid_none_when_unparseable() {
        assert_eq!(id_from_gid("gid://shopify/ProductVariant/not-a-number"), None);
    }

    #[test]
    fn format_num_integral() {
        assert_eq!(format_num(10.0), "10");
    }

    #[test]
    fn format_num_fractional() {
        assert_eq!(format_num(10.5), "10.5");
    }
}
