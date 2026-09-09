use discount_tier::config::{PlatformCfg, PriorityCode, Selector, SelectorType};
use discount_tier::shared::*;
use std::collections::BTreeSet;

#[test]
fn gid_tail() {
    assert_eq!(id_from_gid("gid://shopify/ProductVariant/111"), Some(111));
    assert_eq!(id_from_gid("garbage"), None);
}

#[test]
fn product_selector_falls_back_to_variant() {
    let targets: BTreeSet<i64> = [111].into_iter().collect();
    // product_id absent, variant matches → true (fallback)
    assert!(line_matches(SelectorType::ProductId, Some(111), None, &targets));
    // variant selector requires variant match
    assert!(line_matches(
        SelectorType::VariantId,
        Some(111),
        Some(999),
        &targets
    ));
    assert!(!line_matches(
        SelectorType::VariantId,
        Some(222),
        Some(999),
        &targets
    ));
}

#[test]
fn platform_and_yield_rules() {
    assert!(matches!(current_platform(Some("pos")), PlatformCfg::Pos));
    assert!(platform_allowed(PlatformCfg::Both, PlatformCfg::Pos));
    assert!(!platform_allowed(PlatformCfg::Pos, PlatformCfg::Checkout));

    let codes = vec![PriorityCode {
        code: "VIP".into(),
        selector: Selector::Prefix,
    }];
    // code-triggered run: never yield
    assert!(!should_yield(Some("ANY"), Some("VIPXYZ"), &codes));
    // automatic run + prefix match: yield
    assert!(should_yield(None, Some("VIPXYZ"), &codes));
    assert!(!should_yield(None, Some("NOPE"), &codes));
}
