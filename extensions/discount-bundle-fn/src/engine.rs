//! The bundle engine, ported behaviour-faithfully from `bundle_discount.js`.
//!
//! Per bundle: presence check, target-total + source-OR min-qty gates, the
//! `_resolveMaxDiscountQty` entitlement math (quantity_dependent, target_per_source,
//! fixed_ratios + per-source max_target_qty cap), shared-pool draining, message-only
//! source candidates + discounted target candidates. All bundles merge into one
//! productDiscountsAdd using the first bundle's selection strategy.

use crate::config::{
    ApplyTo, BundleConfig, BundleRule, Operator, PlatformCfg, SelectionStrategy, SelectorType,
};
use crate::shared::{format_num, line_matches, platform_allowed};
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub struct Line {
    pub id: String,
    pub quantity: u32,
    pub variant_id: Option<i64>,
    pub product_id: Option<i64>,
    pub subtotal: f64,
    pub amount_per_qty: f64,
    pub compare_at_per_qty: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DiscountValue {
    Percentage(f64),
    FixedAmountNum(f64),
    FixedAmountStr(String),
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub message: String,
    pub target_ids: Vec<String>,
    pub value: DiscountValue,
}

pub struct BundleOutput {
    pub candidates: Vec<Candidate>,
    pub strategy: SelectionStrategy,
}

fn is_percent(op: Operator) -> bool {
    matches!(op, Operator::Percentage | Operator::Percent)
}

fn ids_for(rule: &BundleRule, selector: SelectorType, is_source: bool) -> BTreeSet<i64> {
    let v = match (selector, is_source) {
        (SelectorType::ProductId, true) => &rule.source_product_ids,
        (SelectorType::ProductId, false) => &rule.target_product_ids,
        (SelectorType::VariantId, true) => &rule.source_variants,
        (SelectorType::VariantId, false) => &rule.target_variants,
    };
    v.iter().copied().collect()
}

fn total_quantity(lines: &[Line], selector: SelectorType, ids: &BTreeSet<i64>) -> u32 {
    lines
        .iter()
        .filter(|l| line_matches(selector, l.variant_id, l.product_id, ids))
        .map(|l| l.quantity)
        .sum()
}

fn any_source_line_meets(lines: &[Line], selector: SelectorType, ids: &BTreeSet<i64>, min_qty: u32) -> bool {
    lines
        .iter()
        .filter(|l| line_matches(selector, l.variant_id, l.product_id, ids))
        .any(|l| l.quantity >= min_qty)
}

fn bundle_message(op: Operator, value: f64, apply_discount: bool, base: &str) -> String {
    if !apply_discount {
        return base.to_string();
    }
    let value_display = if is_percent(op) {
        format!("{}% OFF", format_num(value))
    } else {
        format!("${} OFF", format_num(value))
    };
    if base.trim().is_empty() {
        value_display
    } else {
        format!("{} {}", base, value_display)
    }
}

struct MaxQty {
    max_discount_qty: u32,
    is_quantity_limited: bool,
}

fn resolve_max_discount_qty(rule: &BundleRule, source_qty: u32, total_target_qty: u32) -> MaxQty {
    if !rule.quantity_dependent {
        return MaxQty { max_discount_qty: 0, is_quantity_limited: false };
    }
    let target_per_source = rule.target_per_source.unwrap_or(1).max(1);
    let min_qty = rule.min_qty.unwrap_or(0);
    let source_pool = if min_qty > 0 {
        (source_qty / min_qty) * target_per_source
    } else {
        source_qty * target_per_source
    };

    if !rule.fixed_ratios {
        return MaxQty { max_discount_qty: source_pool, is_quantity_limited: true };
    }

    let has_max = rule.max_target_qty.map(|m| m > 0).unwrap_or(false);
    if has_max {
        let parsed = rule.max_target_qty.unwrap();
        if parsed <= min_qty || parsed <= target_per_source {
            return MaxQty { max_discount_qty: 0, is_quantity_limited: true };
        }
    }

    let target_exact = (total_target_qty / target_per_source) * target_per_source;

    if has_max {
        let parsed = rule.max_target_qty.unwrap();
        let complete_sets = if min_qty > 0 { source_qty / min_qty } else { source_qty };
        let effective_cap = parsed * complete_sets.max(1);
        MaxQty { max_discount_qty: effective_cap.min(target_exact), is_quantity_limited: true }
    } else {
        MaxQty { max_discount_qty: source_pool.min(target_exact), is_quantity_limited: true }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_bundle_candidates(
    lines: &[Line],
    selector: SelectorType,
    ids: &BTreeSet<i64>,
    op: Operator,
    value: f64,
    apply_discount: bool,
    base: &str,
    quantity_dependent: bool,
    max_discount_qty: u32,
    per_line_cap: bool,
    use_compare_at: bool,
) -> Vec<Candidate> {
    let eligible: Vec<&Line> = lines
        .iter()
        .filter(|l| line_matches(selector, l.variant_id, l.product_id, ids))
        .collect();
    if eligible.is_empty() {
        return vec![];
    }

    // Single-candidate path: message-only source, or non-quantity-dependent target.
    if !apply_discount || !quantity_dependent {
        let value_obj = if apply_discount {
            if is_percent(op) {
                DiscountValue::Percentage(value)
            } else {
                DiscountValue::FixedAmountNum(value)
            }
        } else {
            DiscountValue::Percentage(0.0)
        };
        return vec![Candidate {
            message: bundle_message(op, value, apply_discount, base),
            target_ids: eligible.iter().map(|l| l.id.clone()).collect(),
            value: value_obj,
        }];
    }

    // Quantity-dependent draining path (target only).
    let mut out = Vec::new();
    let mut remaining_discount_qty: i64 = max_discount_qty as i64;
    for l in eligible {
        let available_qty: i64 = if per_line_cap { max_discount_qty as i64 } else { remaining_discount_qty };
        let qty_to_discount = if use_compare_at {
            if available_qty <= 0 {
                0
            } else {
                (l.quantity as i64).min(available_qty).max(0)
            }
        } else if available_qty <= 0 {
            0
        } else {
            (l.quantity as i64).min(available_qty)
        };

        if qty_to_discount <= 0 {
            out.push(Candidate {
                message: base.to_string(),
                target_ids: vec![l.id.clone()],
                value: DiscountValue::Percentage(0.0),
            });
            continue;
        }

        let msg = bundle_message(op, value, true, base);
        let candidate = if use_compare_at {
            build_compare_at_candidate(l, op, value, &msg, qty_to_discount as u32)
        } else if is_percent(op) {
            Some(if qty_to_discount as u32 >= l.quantity {
                Candidate { message: msg, target_ids: vec![l.id.clone()], value: DiscountValue::Percentage(value) }
            } else {
                let total = ((l.amount_per_qty * (value / 100.0)) * qty_to_discount as f64 * 100.0).round() / 100.0;
                Candidate { message: msg, target_ids: vec![l.id.clone()], value: DiscountValue::FixedAmountStr(format_num(total)) }
            })
        } else {
            let total = value * qty_to_discount as f64;
            Some(Candidate { message: msg, target_ids: vec![l.id.clone()], value: DiscountValue::FixedAmountStr(format_num(total)) })
        };

        match candidate {
            Some(c) => {
                out.push(c);
                if !per_line_cap {
                    remaining_discount_qty -= qty_to_discount;
                }
            }
            None => {
                // compare-at skip (invalid compare-at) → emit nothing for this line
            }
        }
    }
    out
}

fn build_compare_at_candidate(
    line: &Line,
    op: Operator,
    value: f64,
    msg: &str,
    qty_to_discount: u32,
) -> Option<Candidate> {
    let current = line.amount_per_qty;
    if current <= 0.0 {
        return None;
    }
    let compare_at = match line.compare_at_per_qty {
        Some(c) if c > 0.0 => c,
        _ => current,
    };
    if compare_at < current {
        return None;
    }
    let per_item = if is_percent(op) {
        (current - compare_at * (1.0 - value / 100.0)).max(0.0)
    } else {
        value.min(current)
    };
    let total = (per_item * qty_to_discount as f64 * 100.0).round() / 100.0;
    Some(Candidate {
        message: msg.to_string(),
        target_ids: vec![line.id.clone()],
        value: DiscountValue::FixedAmountStr(format_num(total)),
    })
}

pub fn build_candidates(cfg: &BundleConfig, lines: &[Line], current: PlatformCfg) -> BundleOutput {
    let strategy = cfg
        .bundle_discounts
        .first()
        .and_then(|b| b.selection_strategy)
        .unwrap_or_default();

    let mut candidates = Vec::new();

    for rule in &cfg.bundle_discounts {
        let rule_platform = rule.platform.unwrap_or(cfg.platform);
        if !platform_allowed(rule_platform, current) {
            continue;
        }

        let src_ids = ids_for(rule, rule.source_selector_type, true);
        let tgt_ids = ids_for(rule, rule.target_selector_type, false);

        let has_source = lines
            .iter()
            .any(|l| line_matches(rule.source_selector_type, l.variant_id, l.product_id, &src_ids));
        let has_target = lines
            .iter()
            .any(|l| line_matches(rule.target_selector_type, l.variant_id, l.product_id, &tgt_ids));
        if !has_source || !has_target {
            continue;
        }

        let min_qty = rule.min_qty.unwrap_or(0);
        let total_target_qty = total_quantity(lines, rule.target_selector_type, &tgt_ids);
        if min_qty > 0 && total_target_qty < min_qty {
            continue;
        }
        if min_qty > 0 && !any_source_line_meets(lines, rule.source_selector_type, &src_ids, min_qty) {
            continue;
        }

        if rule.value <= 0.0 {
            continue;
        }

        let source_qty = total_quantity(lines, rule.source_selector_type, &src_ids);
        let resolved = resolve_max_discount_qty(rule, source_qty, total_target_qty);
        if resolved.is_quantity_limited && resolved.max_discount_qty == 0 {
            continue; // skip whole bundle — no message, no 0% candidates
        }

        let shared_pool = rule.shared_pool;
        let per_line_cap = resolved.is_quantity_limited && !shared_pool;
        let use_compare_at = matches!(rule.apply_to, Some(ApplyTo::CompareAtPrice));

        // Source: message-only 0% candidate(s).
        let source = build_bundle_candidates(
            lines,
            rule.source_selector_type,
            &src_ids,
            rule.operator,
            rule.value,
            false,
            &rule.message,
            false,
            0,
            false,
            use_compare_at,
        );
        // Target: discounted candidates (draining when quantity-limited).
        let target = build_bundle_candidates(
            lines,
            rule.target_selector_type,
            &tgt_ids,
            rule.operator,
            rule.value,
            true,
            &rule.message,
            resolved.is_quantity_limited,
            resolved.max_discount_qty,
            per_line_cap,
            use_compare_at,
        );

        candidates.extend(source);
        candidates.extend(target);
    }

    BundleOutput { candidates, strategy }
}
