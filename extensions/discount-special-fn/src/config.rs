//! Tolerant, fail-safe serde structs for `$app:discount-special.config`.

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

#[derive(Debug, Clone, Deserialize)]
pub struct SpecialTarget {
    #[serde(default)]
    pub target_selector_type: SelectorType,
    #[serde(default)]
    pub target_variants: Vec<i64>,
    #[serde(default)]
    pub target_product_ids: Vec<i64>,
    #[serde(default)]
    pub target_operator: Option<Operator>,
    #[serde(default)]
    pub target_value: f64,
    #[serde(default)]
    pub target_message: String,
}

#[derive(Debug, Deserialize)]
pub struct SpecialRule {
    #[serde(default)]
    pub source_selector_type: SelectorType,
    #[serde(default)]
    pub source_variants: Vec<i64>,
    #[serde(default)]
    pub source_product_ids: Vec<i64>,
    #[serde(default)]
    pub source_operator: Option<Operator>,
    #[serde(default)]
    pub source_value: f64,
    #[serde(default)]
    pub source_message: String,
    /// Config-level operator fallback for target groups (rarely set).
    #[serde(default)]
    pub operator: Option<Operator>,
    #[serde(default)]
    pub apply_to: Option<ApplyTo>,
    #[serde(default)]
    pub platform: Option<PlatformCfg>,
    #[serde(default)]
    pub targets: Vec<SpecialTarget>,
    // Legacy flattened single-target fields (used when `targets` is absent).
    #[serde(default)]
    pub target_selector_type: Option<SelectorType>,
    #[serde(default)]
    pub target_variants: Vec<i64>,
    #[serde(default)]
    pub target_product_ids: Vec<i64>,
    #[serde(default)]
    pub target_operator: Option<Operator>,
    #[serde(default)]
    pub target_value: Option<f64>,
    #[serde(default)]
    pub target_message: Option<String>,
    #[serde(default)]
    pub message: String,
    #[serde(default, rename = "product_discount_selection_strategy")]
    pub selection_strategy: Option<SelectionStrategy>,
    #[serde(default)]
    pub quantity_dependent: bool,
    #[serde(default)]
    pub target_per_source: Option<u32>,
    #[serde(default, alias = "fixed_ratio", alias = "fixedRatio")]
    pub fixed_ratios: bool,
    #[serde(default = "default_true")]
    pub shared_pool: bool,
    #[serde(default)]
    pub min_qty: Option<u32>,
}

impl SpecialRule {
    /// Reproduce `_normalizeTargets`: use `targets` if present, else synthesize a
    /// single group from the legacy flattened fields, else empty.
    pub fn normalized_targets(&self) -> Vec<SpecialTarget> {
        if !self.targets.is_empty() {
            return self.targets.clone();
        }
        let has_legacy = self.target_selector_type.is_some()
            || !self.target_variants.is_empty()
            || !self.target_product_ids.is_empty();
        if has_legacy {
            vec![SpecialTarget {
                target_selector_type: self.target_selector_type.unwrap_or_default(),
                target_variants: self.target_variants.clone(),
                target_product_ids: self.target_product_ids.clone(),
                target_operator: self.target_operator,
                target_value: self.target_value.unwrap_or(0.0),
                target_message: self.target_message.clone().unwrap_or_default(),
            }]
        } else {
            vec![]
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct SpecialConfig {
    #[serde(default)]
    pub platform: PlatformCfg,
    #[serde(default)]
    pub special_discounts: Vec<SpecialRule>,
    /// Singular alternative form (`_normalizeSpecialDiscounts`).
    #[serde(default)]
    pub special_discount: Option<SpecialRule>,
}

impl SpecialConfig {
    pub fn rules(&self) -> Vec<&SpecialRule> {
        if !self.special_discounts.is_empty() {
            self.special_discounts.iter().collect()
        } else if let Some(s) = &self.special_discount {
            vec![s]
        } else {
            vec![]
        }
    }
}

pub fn parse_special_config(raw: Option<&str>) -> Option<SpecialConfig> {
    let s = raw?;
    if s.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<SpecialConfig>(s).ok()
}
