//! Tolerant, fail-safe serde structs for `$app:discount-bundle.config`.
//! A null/empty/unparseable value → `None` (caller emits zero operations).

use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SelectorType {
    #[default]
    VariantId,
    ProductId,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Operator {
    #[default]
    Percentage,
    Percent,
    Amount,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApplyTo {
    #[default]
    Price,
    CompareAtPrice,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum SelectionStrategy {
    #[default]
    All,
    First,
    Maximum,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum PlatformCfg {
    #[default]
    Both,
    Pos,
    Checkout,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
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

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct BundleRule {
    #[serde(default)]
    pub source_selector_type: SelectorType,
    #[serde(default)]
    pub target_selector_type: SelectorType,
    #[serde(default)]
    pub source_variants: Vec<i64>,
    #[serde(default)]
    pub target_variants: Vec<i64>,
    #[serde(default)]
    pub source_product_ids: Vec<i64>,
    #[serde(default)]
    pub target_product_ids: Vec<i64>,
    #[serde(default)]
    pub operator: Operator,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub apply_to: Option<ApplyTo>,
    #[serde(default)]
    pub platform: Option<PlatformCfg>,
    #[serde(default, rename = "product_discount_selection_strategy")]
    pub selection_strategy: Option<SelectionStrategy>,
    #[serde(default)]
    pub quantity_dependent: bool,
    #[serde(default)]
    pub target_per_source: Option<u32>,
    #[serde(default, alias = "fixed_ratio", alias = "fixedRatio")]
    pub fixed_ratios: bool,
    #[serde(default)]
    pub max_target_qty: Option<u32>,
    #[serde(default = "default_true")]
    pub shared_pool: bool,
    #[serde(default)]
    pub min_qty: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
pub struct BundleConfig {
    #[serde(default)]
    pub platform: PlatformCfg,
    #[serde(default)]
    pub bundle_discounts: Vec<BundleRule>,
}

pub fn parse_bundle_config(raw: Option<&str>) -> Option<BundleConfig> {
    let s = raw?;
    if s.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<BundleConfig>(s).ok()
}
