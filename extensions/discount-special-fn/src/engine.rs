//! The special engine, ported behaviour-faithfully from `special_discount.js`.
//!
//! Per special: source candidates (always included, never quantity-dependent),
//! plus N independently-priced target groups drawing from a shared pool. For
//! `fixed_ratios`, target quantity is counted across ALL groups. The per-group
//! selection strategy (ALL/FIRST/MAXIMUM) filters target groups; source bypasses it.

use crate::config::{
    ApplyTo, Operator, PlatformCfg, SelectionStrategy, SelectorType, SpecialConfig, SpecialRule,
    SpecialTarget,
};
use crate::shared::{format_num, line_matches, platform_allowed};
use std::collections::{BTreeSet, HashMap};

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

fn is_percent(op: Operator) -> bool {
    matches!(op, Operator::Percentage | Operator::Percent)
}

fn ids_from(variants: &[i64], products: &[i64], selector: SelectorType) -> BTreeSet<i64> {
    match selector {
        SelectorType::ProductId => products.iter().copied().collect(),
        SelectorType::VariantId => variants.iter().copied().collect(),
    }
}

fn total_quantity(lines: &[Line], selector: SelectorType, ids: &BTreeSet<i64>) -> u32 {
    lines
        .iter()
        .filter(|l| line_matches(selector, l.variant_id, l.product_id, ids))
        .map(|l| l.quantity)
        .sum()
}

fn build_msg(op: Operator, value: f64, base: &str) -> String {
    let value_display = if is_percent(op) {
        format!("{}% OFF", format_num(value))
    } else {
        format!("${} OFF", format_num(value))
    };
    if base.is_empty() {
        return value_display;
    }
    if base.contains("OFF") || base.contains('%') || base.contains('$') {
        base.to_string()
    } else {
        format!("{} {}", base, value_display)
    }
}

fn discount_value_non_qd(op: Operator, value: f64) -> DiscountValue {
    if is_percent(op) {
        DiscountValue::Percentage(value)
    } else {
        DiscountValue::FixedAmountNum(value)
    }
}

/// `_buildDiscountCandidates` + `_buildStandardCandidates` / compare-at.
#[allow(clippy::too_many_arguments)]
fn build_discount_candidates(
    lines: &[Line],
    selector: SelectorType,
    ids: &BTreeSet<i64>,
    op: Operator,
    value: f64,
    message: &str,
    apply_to: Option<ApplyTo>,
    quantity_dependent: bool,
    max_discount_qty: f64,
    per_line_cap: bool,
) -> Vec<Candidate> {
    let eligible: Vec<&Line> = lines
        .iter()
        .filter(|l| line_matches(selector, l.variant_id, l.product_id, ids))
        .collect();
    if eligible.is_empty() {
        return vec![];
    }
    let use_compare_at = matches!(apply_to, Some(ApplyTo::CompareAtPrice));

    if !quantity_dependent {
        // Single candidate with all eligible lines.
        if use_compare_at {
            // Non-qd compare-at: one candidate per line (fixedAmount).
            return eligible
                .iter()
                .filter_map(|l| compare_at_candidate(l, op, value, message, l.quantity))
                .collect();
        }
        return vec![Candidate {
            message: message.to_string(),
            target_ids: eligible.iter().map(|l| l.id.clone()).collect(),
            value: discount_value_non_qd(op, value),
        }];
    }

    // Quantity-dependent draining.
    let mut out = Vec::new();
    let mut remaining_discount_qty = max_discount_qty;
    for l in eligible {
        let available_qty = if per_line_cap { max_discount_qty } else { remaining_discount_qty };
        let qty_to_discount = if available_qty <= 0.0 {
            0.0
        } else {
            (l.quantity as f64).min(available_qty).max(0.0)
        };
        if qty_to_discount <= 0.0 {
            out.push(Candidate {
                message: message.to_string(),
                target_ids: vec![l.id.clone()],
                value: DiscountValue::Percentage(0.0),
            });
            continue;
        }
        let built = if use_compare_at {
            compare_at_candidate(l, op, value, message, qty_to_discount as u32)
        } else if is_percent(op) {
            Some(if qty_to_discount as u32 >= l.quantity {
                Candidate { message: message.to_string(), target_ids: vec![l.id.clone()], value: DiscountValue::Percentage(value) }
            } else {
                let total = ((l.amount_per_qty * (value / 100.0)) * qty_to_discount * 100.0).round() / 100.0;
                Candidate { message: message.to_string(), target_ids: vec![l.id.clone()], value: DiscountValue::FixedAmountStr(format_num(total)) }
            })
        } else {
            let total = value * qty_to_discount;
            Some(Candidate { message: message.to_string(), target_ids: vec![l.id.clone()], value: DiscountValue::FixedAmountStr(format_num(total)) })
        };
        if let Some(c) = built {
            out.push(c);
            if !per_line_cap {
                remaining_discount_qty -= qty_to_discount;
            }
        }
    }
    out
}

fn compare_at_candidate(line: &Line, op: Operator, value: f64, message: &str, qty: u32) -> Option<Candidate> {
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
    let desired_final = if is_percent(op) {
        compare_at * (1.0 - value / 100.0)
    } else {
        compare_at - value
    };
    let from_compare_at = (current - desired_final).max(0.0);
    let per_item = if from_compare_at == 0.0 || (compare_at - current).abs() < f64::EPSILON {
        // fallback to selling-price discount
        if is_percent(op) {
            current * (value / 100.0)
        } else {
            value.min(current)
        }
    } else {
        from_compare_at
    };
    let total = (per_item * qty as f64 * 100.0).round() / 100.0;
    Some(Candidate {
        message: message.to_string(),
        target_ids: vec![line.id.clone()],
        value: DiscountValue::FixedAmountStr(format_num(total)),
    })
}

struct Pool {
    shared_pool: f64,
    quantity_dependent: bool,
}

fn resolve_shared_pool(
    rule: &SpecialRule,
    source_selector: SelectorType,
    source_ids: &BTreeSet<i64>,
    targets: &[SpecialTarget],
    lines: &[Line],
) -> Pool {
    if !rule.quantity_dependent {
        return Pool { shared_pool: f64::INFINITY, quantity_dependent: false };
    }
    let target_per_source = rule.target_per_source.unwrap_or(1).max(1);
    let min_qty = rule.min_qty.unwrap_or(0);
    let source_qty = total_quantity(lines, source_selector, source_ids);
    let source_pool = if min_qty > 0 {
        (source_qty / min_qty) * target_per_source
    } else {
        source_qty * target_per_source
    };
    if !rule.fixed_ratios {
        return Pool { shared_pool: source_pool as f64, quantity_dependent: true };
    }
    let total_target_qty: u32 = targets
        .iter()
        .map(|t| {
            let ids = ids_from(&t.target_variants, &t.target_product_ids, t.target_selector_type);
            total_quantity(lines, t.target_selector_type, &ids)
        })
        .sum();
    let target_exact = (total_target_qty / target_per_source) * target_per_source;
    Pool { shared_pool: source_pool.min(target_exact) as f64, quantity_dependent: true }
}

fn count_discounted_qty(candidates: &[Candidate], qty_by_id: &HashMap<&str, u32>) -> f64 {
    let mut total = 0.0;
    for c in candidates {
        let Some(id) = c.target_ids.first() else { continue };
        let line_qty = *qty_by_id.get(id.as_str()).unwrap_or(&0) as f64;
        match &c.value {
            DiscountValue::Percentage(v) => {
                if *v != 0.0 {
                    total += line_qty;
                }
            }
            DiscountValue::FixedAmountNum(_) | DiscountValue::FixedAmountStr(_) => {
                total += line_qty;
            }
        }
    }
    total
}

fn magnitude(c: &Candidate) -> f64 {
    match &c.value {
        DiscountValue::Percentage(v) => *v,
        DiscountValue::FixedAmountNum(n) => *n,
        DiscountValue::FixedAmountStr(s) => s.parse::<f64>().unwrap_or(0.0),
    }
}

fn apply_selection_strategy(grouped: Vec<Vec<Candidate>>, strategy: SelectionStrategy) -> Vec<Candidate> {
    let non_empty: Vec<Vec<Candidate>> = grouped.into_iter().filter(|g| !g.is_empty()).collect();
    if non_empty.is_empty() {
        return vec![];
    }
    match strategy {
        SelectionStrategy::All => non_empty.into_iter().flatten().collect(),
        SelectionStrategy::First => non_empty.into_iter().next().unwrap(),
        SelectionStrategy::Maximum => {
            let mut best_idx = 0;
            let mut best_mag: f64 = non_empty[0].iter().map(magnitude).sum();
            for (i, g) in non_empty.iter().enumerate().skip(1) {
                let m: f64 = g.iter().map(magnitude).sum();
                if m > best_mag {
                    best_mag = m;
                    best_idx = i;
                }
            }
            non_empty.into_iter().nth(best_idx).unwrap()
        }
    }
}

fn build_target_group(
    lines: &[Line],
    group: &SpecialTarget,
    rule: &SpecialRule,
    quantity_dependent: bool,
    available_for_group: f64,
) -> Vec<Candidate> {
    let ids = ids_from(&group.target_variants, &group.target_product_ids, group.target_selector_type);
    if ids.is_empty() {
        return vec![];
    }
    let op = group.target_operator.or(rule.operator).unwrap_or_default();
    let value = group.target_value;
    if value <= 0.0 {
        return vec![];
    }
    let max_discount_qty = if quantity_dependent { available_for_group } else { f64::INFINITY };
    let per_line_cap = quantity_dependent && !rule.shared_pool;
    let message = build_msg(op, value, &group.target_message);
    build_discount_candidates(
        lines,
        group.target_selector_type,
        &ids,
        op,
        value,
        &message,
        rule.apply_to,
        quantity_dependent,
        max_discount_qty,
        per_line_cap,
    )
}

fn process_special(rule: &SpecialRule, lines: &[Line], current: PlatformCfg) -> (Vec<Candidate>, Vec<Candidate>) {
    let rule_platform = rule.platform.unwrap_or(PlatformCfg::Both);
    // rule platform falls back to root platform via caller; here honor rule-level then current.
    if !platform_allowed(rule_platform, current) {
        return (vec![], vec![]);
    }

    let source_ids = ids_from(&rule.source_variants, &rule.source_product_ids, rule.source_selector_type);
    let targets = rule.normalized_targets();
    if targets.is_empty() {
        return (vec![], vec![]);
    }

    // presence: source AND at least one target group's item
    let has_source = lines
        .iter()
        .any(|l| line_matches(rule.source_selector_type, l.variant_id, l.product_id, &source_ids));
    let has_any_target = targets.iter().any(|t| {
        let ids = ids_from(&t.target_variants, &t.target_product_ids, t.target_selector_type);
        lines.iter().any(|l| line_matches(t.target_selector_type, l.variant_id, l.product_id, &ids))
    });
    if !has_source || !has_any_target {
        return (vec![], vec![]);
    }

    // source min-qty OR gate
    let min_qty = rule.min_qty.unwrap_or(0);
    if min_qty > 0 {
        let ok = lines
            .iter()
            .filter(|l| line_matches(rule.source_selector_type, l.variant_id, l.product_id, &source_ids))
            .any(|l| l.quantity >= min_qty);
        if !ok {
            return (vec![], vec![]);
        }
    }

    let source_op = rule.source_operator.or(rule.operator).unwrap_or_default();
    let source_value = rule.source_value;
    let has_valid_source = source_value > 0.0;
    let has_valid_target = targets.iter().any(|t| t.target_value > 0.0);
    if !has_valid_source && !has_valid_target {
        return (vec![], vec![]);
    }

    let pool = resolve_shared_pool(rule, rule.source_selector_type, &source_ids, &targets, lines);

    let source_cands = if has_valid_source {
        let msg = build_msg(source_op, source_value, &rule.source_message);
        build_discount_candidates(
            lines,
            rule.source_selector_type,
            &source_ids,
            source_op,
            source_value,
            &msg,
            rule.apply_to,
            false,
            f64::INFINITY,
            false,
        )
    } else {
        vec![]
    };

    let qty_by_id: HashMap<&str, u32> = lines.iter().map(|l| (l.id.as_str(), l.quantity)).collect();
    let strategy = rule.selection_strategy.unwrap_or_default();
    let mut remaining_pool = pool.shared_pool;
    let mut grouped: Vec<Vec<Candidate>> = Vec::new();
    for group in &targets {
        let available_for_group = if pool.quantity_dependent { remaining_pool } else { f64::INFINITY };
        if pool.quantity_dependent && available_for_group <= 0.0 {
            grouped.push(vec![]);
            continue;
        }
        let built = build_target_group(lines, group, rule, pool.quantity_dependent, available_for_group);
        if pool.quantity_dependent && remaining_pool.is_finite() {
            let consumed = count_discounted_qty(&built, &qty_by_id);
            remaining_pool = (remaining_pool - consumed).max(0.0);
        }
        grouped.push(built);
    }

    let filtered = apply_selection_strategy(grouped, strategy);
    (source_cands, filtered)
}

/// Returns the merged candidate list (source candidates first, then filtered
/// target candidates). The operation-level selection strategy is ALL.
pub fn build_candidates(cfg: &SpecialConfig, lines: &[Line], current: PlatformCfg) -> Vec<Candidate> {
    let mut all_source = Vec::new();
    let mut all_target = Vec::new();
    for rule in cfg.rules() {
        // rule platform falls back to root platform.
        let rp = rule.platform.unwrap_or(cfg.platform);
        if !platform_allowed(rp, current) {
            continue;
        }
        let (s, t) = process_special(rule, lines, current);
        if s.is_empty() && t.is_empty() {
            continue;
        }
        all_source.extend(s);
        all_target.extend(t);
    }
    let mut out = all_source;
    out.extend(all_target);
    out
}
