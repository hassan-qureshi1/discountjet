//! Tolerant serde structs for the shop `checkout.discount_engine` metafield
//! and the `bundle.composition_v2` variant metafield.
//! Ported from `eva/discount-engine`'s `cart-transform-applier.js` /
//! `bundle-expander.js` / `cart_transform_run.js` (`parseDiscountEngineConfig`).

use serde::Deserialize;

/// A single cart-attribute-style message to stamp onto an expanded item.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MessageAttr {
    pub key: String,
    pub value: String,
}

/// One entry of `config.target_variants`.
#[derive(Debug, Clone, Deserialize)]
pub struct TargetVariant {
    pub id: i64,
    pub price: String,
    #[serde(default)]
    #[allow(dead_code)] // read for parity with the JS shape; not used in pricing logic
    pub compare_at_price: Option<String>,
}

/// `config.platform_source` may be a single string or an array of strings.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PlatformSourceValue {
    One(String),
    Many(Vec<String>),
}

impl PlatformSourceValue {
    /// Mirrors JS:
    /// `(Array.isArray(v) ? v : [v]).map(s => String(s).toUpperCase())`.
    pub fn as_upper_set(&self) -> Vec<String> {
        match self {
            PlatformSourceValue::One(s) => vec![s.to_uppercase()],
            PlatformSourceValue::Many(v) => v.iter().map(|s| s.to_uppercase()).collect(),
        }
    }
}

/// One entry of the `checkout.discount_engine` config array (or the whole
/// value, when it's a single object rather than an array of them).
#[derive(Debug, Clone, Deserialize)]
pub struct EngineConfig {
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Vec<MessageAttr>,
    #[serde(default)]
    pub apply_to_message: Option<String>,
    #[serde(default)]
    pub platform_source: Option<PlatformSourceValue>,
    #[serde(default)]
    pub target_quantity: Option<i64>,
    #[serde(default)]
    pub source_variants: Vec<i64>,
    #[serde(default)]
    pub target_variants: Vec<TargetVariant>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub operator: Option<String>,
}

/// Parse the shop `checkout.discount_engine` metafield for Pass 2 (the config
/// applier). Mirrors JS `parseDiscountEngineConfig`:
///  - missing value, empty string, or the legacy placeholder `[{}]` -> `[]`
///  - invalid JSON -> `[]`
///  - a single JSON object (not wrapped in an array) is normalized to a
///    one-element vec, mirroring the `CartTransformer` constructor's
///    `Array.isArray(configs) ? configs : [configs]`.
///
/// Deviation from JS: individual array entries whose shape doesn't match
/// `EngineConfig` at all (e.g. a non-object array entry) are skipped rather
/// than aborting the whole parse — JS's fully-dynamic field access never
/// hard-fails on a single malformed entry, it just falls back per-field via
/// optional chaining. Skipping keeps the rest of a heterogeneous array usable
/// instead of collapsing to `[]`, which is the closer-to-intent behavior.
pub fn parse_discount_engine_config(raw: Option<&str>) -> Vec<EngineConfig> {
    let raw = match raw {
        Some(s) if !s.is_empty() && s != "[{}]" => s,
        _ => return Vec::new(),
    };

    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value::<EngineConfig>(item).ok())
            .collect(),
        other => serde_json::from_value::<EngineConfig>(other)
            .map(|c| vec![c])
            .unwrap_or_default(),
    }
}

/// One entry of the shop `checkout.priority_codes` metafield JSON array.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PriorityCodeEntry {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
}

/// A single component of a `bundle.composition_v2` metafield JSON array.
#[derive(Debug, Clone, Deserialize)]
pub struct BundleComponent {
    pub id: String,
    pub quantity: i64,
    pub price: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_yields_empty() {
        assert!(parse_discount_engine_config(None).is_empty());
    }

    #[test]
    fn empty_string_yields_empty() {
        assert!(parse_discount_engine_config(Some("")).is_empty());
    }

    #[test]
    fn legacy_placeholder_yields_empty() {
        assert!(parse_discount_engine_config(Some("[{}]")).is_empty());
    }

    #[test]
    fn invalid_json_yields_empty() {
        assert!(parse_discount_engine_config(Some("not json")).is_empty());
    }

    #[test]
    fn array_of_configs_parses() {
        let raw = r#"[{"source_variants":[1,2],"target_variants":[],"value":10,"operator":"%","condition":"ALL"}]"#;
        let cfgs = parse_discount_engine_config(Some(raw));
        assert_eq!(cfgs.len(), 1);
        assert_eq!(cfgs[0].source_variants, vec![1, 2]);
    }

    #[test]
    fn single_object_is_wrapped_in_vec() {
        let raw = r#"{"source_variants":[1],"target_variants":[],"value":5}"#;
        let cfgs = parse_discount_engine_config(Some(raw));
        assert_eq!(cfgs.len(), 1);
    }
}
