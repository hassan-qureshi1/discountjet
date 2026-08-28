//! Tolerant, fail-safe serde structs for the `$app:discount-tier.config`
//! metafield. `#[serde(default)]` + ignore-unknown means a `rule_type`,
//! `targets_full`, or any extra field is silently tolerated; a null / empty /
//! unparseable value yields `None` (the caller then emits zero operations).

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ApplyTo {
    #[default]
    Price,
    CompareAtPrice,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum DiscountType {
    #[default]
    Percentage,
    Percent,
    Amount,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
#[derive(Default)]
pub enum SelectionStrategy {
    #[default]
    All,
    First,
    Maximum,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SelectorType {
    VariantId,
    #[default]
    ProductId,
}
// Matches JS `_normalizeSelectorType` default of 'product_id'.

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
#[derive(Default)]
pub enum PlatformCfg {
    #[default]
    Both,
    Pos,
    Checkout,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Selector {
    Prefix,
    Suffix,
    #[default]
    Exact,
}

#[derive(Debug, Deserialize)]
pub struct PriorityCode {
    pub code: String,
    #[serde(default)]
    pub selector: Selector,
}

#[derive(Debug, Default, Deserialize)]
pub struct TierEntry {
    #[serde(default)]
    pub product_selector_type: SelectorType,
    #[serde(default)]
    pub targets: Vec<i64>,
    #[serde(default)]
    pub min_qty: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TierConfig {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub apply_to: ApplyTo,
    #[serde(default)]
    pub discount_type: DiscountType,
    #[serde(default, rename = "product_discount_selection_strategy")]
    pub selection_strategy: SelectionStrategy,
    #[serde(default)]
    pub platform: PlatformCfg,
    #[serde(default)]
    pub discount_tiers: BTreeMap<String, TierEntry>,
}

/// Parse the raw metafield value. Fail-safe: `None` on null / empty / parse error.
pub fn parse_tier_config(raw: Option<&str>) -> Option<TierConfig> {
    let s = raw?;
    if s.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<TierConfig>(s).ok()
}
