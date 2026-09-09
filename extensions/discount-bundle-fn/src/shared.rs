//! Shared cart-input helpers for the bundle function (ported from the applier
//! utils). Pure functions — no Shopify types.

use crate::config::{PlatformCfg, PriorityCode, Selector, SelectionStrategy, SelectorType};
use std::collections::BTreeSet;

pub fn id_from_gid(gid: &str) -> Option<i64> {
    gid.rsplit('/').next()?.parse::<i64>().ok()
}

pub fn line_matches(
    selector: SelectorType,
    variant_id: Option<i64>,
    product_id: Option<i64>,
    targets: &BTreeSet<i64>,
) -> bool {
    match selector {
        SelectorType::VariantId => variant_id.is_some_and(|v| targets.contains(&v)),
        SelectorType::ProductId => {
            if let Some(p) = product_id {
                targets.contains(&p)
            } else {
                variant_id.is_some_and(|v| targets.contains(&v))
            }
        }
    }
}

pub fn current_platform(attr_value: Option<&str>) -> PlatformCfg {
    match attr_value {
        Some(v) if v.to_uppercase() == "POS" => PlatformCfg::Pos,
        _ => PlatformCfg::Checkout,
    }
}

pub fn platform_allowed(cfg: PlatformCfg, current: PlatformCfg) -> bool {
    matches!(cfg, PlatformCfg::Both)
        || matches!(
            (cfg, current),
            (PlatformCfg::Pos, PlatformCfg::Pos) | (PlatformCfg::Checkout, PlatformCfg::Checkout)
        )
}

pub fn should_yield(
    triggering_code: Option<&str>,
    cart_code: Option<&str>,
    codes: &[PriorityCode],
) -> bool {
    if let Some(t) = triggering_code {
        if !t.is_empty() {
            return false;
        }
    }
    let cart = match cart_code {
        Some(c) if !c.is_empty() => c,
        _ => return false,
    };
    codes.iter().any(|c| match c.selector {
        Selector::Prefix => cart.starts_with(&c.code),
        Selector::Suffix => cart.ends_with(&c.code),
        Selector::Exact => cart == c.code,
    })
}

pub fn strategy_enum(s: SelectionStrategy) -> &'static str {
    match s {
        SelectionStrategy::All => "ALL",
        SelectionStrategy::First => "FIRST",
        SelectionStrategy::Maximum => "MAXIMUM",
    }
}

/// Render an f64 the way JS `Number -> String` does for our cases.
pub fn format_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}
