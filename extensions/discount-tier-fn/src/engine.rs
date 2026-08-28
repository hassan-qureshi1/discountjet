//! The tier engine, ported behaviour-faithfully from `tier_discount.js`.
//!
//! Non-obvious behaviours preserved:
//! - `discount_tiers` is a keyed object; every tier fires independently (no
//!   "best tier wins").
//! - `min_qty` is a PER-LINE threshold (`line.quantity >= min_qty`).
//! - Standard/price path groups all selected lines into ONE candidate;
//!   compare-at path emits ONE candidate PER line.
//! - `fixedAmount.amount` is a JSON number on the price path but a string on
//!   the compare-at path (matching the JS).
//! - Message is always suffixed `% OFF`, even for amount discounts.

use crate::config::{ApplyTo, DiscountType, SelectionStrategy, SelectorType, TierConfig};
use crate::shared::line_matches;
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

#[derive(Debug, Clone)]
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

fn is_percentage(cfg: &TierConfig) -> bool {
    matches!(
        cfg.discount_type,
        DiscountType::Percentage | DiscountType::Percent
    )
}

fn tier_message(cfg: &TierConfig, tier_key: f64) -> String {
    let key = format_num(tier_key);
    match &cfg.message {
        Some(m) if !m.trim().is_empty() => format!("{} {}% OFF", m, key),
        _ => format!("{}% OFF", key),
    }
}

/// Render a number the way JS `Number -> String` does for our cases: an integer
/// without a trailing `.0`, otherwise the shortest decimal.
fn format_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        let s = format!("{}", n);
        s
    }
}

fn eligible_lines<'a>(
    lines: &'a [Line],
    selector: SelectorType,
    targets: &BTreeSet<i64>,
    min_qty: u32,
) -> Vec<&'a Line> {
    lines
        .iter()
        .filter(|l| {
            if !line_matches(selector, l.variant_id, l.product_id, targets) {
                return false;
            }
            if min_qty > 0 {
                l.quantity >= min_qty
            } else {
                true
            }
        })
        .collect()
}

fn select_targets<'a>(
    eligible: &[&'a Line],
    strategy: SelectionStrategy,
    tier_key: f64,
) -> Vec<&'a Line> {
    if eligible.is_empty() {
        return vec![];
    }
    match strategy {
        SelectionStrategy::First => vec![eligible[0]],
        SelectionStrategy::All => eligible.to_vec(),
        SelectionStrategy::Maximum => {
            // Highest `subtotal * (tier_key/100)`; strict `>`, ties keep earlier.
            let mut best = eligible[0];
            let mut best_disc = best.subtotal * (tier_key / 100.0);
            for l in &eligible[1..] {
                let d = l.subtotal * (tier_key / 100.0);
                if d > best_disc {
                    best = l;
                    best_disc = d;
                }
            }
            vec![best]
        }
    }
}

pub fn build_candidates(cfg: &TierConfig, lines: &[Line]) -> Vec<Candidate> {
    if cfg.discount_tiers.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    for (key, entry) in &cfg.discount_tiers {
        let tier_key: f64 = match key.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let targets: BTreeSet<i64> = entry.targets.iter().copied().collect();
        let min_qty = entry.min_qty.unwrap_or(0);
        let eligible = eligible_lines(lines, entry.product_selector_type, &targets, min_qty);
        let selected = select_targets(&eligible, cfg.selection_strategy, tier_key);
        if selected.is_empty() {
            continue;
        }
        let message = tier_message(cfg, tier_key);

        match cfg.apply_to {
            ApplyTo::CompareAtPrice => {
                out.extend(build_compare_at(cfg, tier_key, &selected, &message));
            }
            ApplyTo::Price => {
                let value = if is_percentage(cfg) {
                    DiscountValue::Percentage(tier_key)
                } else if matches!(cfg.discount_type, DiscountType::Amount) {
                    DiscountValue::FixedAmountNum(tier_key)
                } else {
                    DiscountValue::Percentage(tier_key)
                };
                out.push(Candidate {
                    message,
                    target_ids: selected.iter().map(|l| l.id.clone()).collect(),
                    value,
                });
            }
        }
    }
    out
}

/// Compare-at path: one candidate per line, `fixedAmount` as a rounded string,
/// skipping lines whose compare-at is below the current price, falling back to
/// the selling price when compare-at is absent or <= 0.
fn build_compare_at(
    cfg: &TierConfig,
    tier_key: f64,
    selected: &[&Line],
    message: &str,
) -> Vec<Candidate> {
    let percentage = is_percentage(cfg);
    selected
        .iter()
        .filter_map(|l| {
            let current = l.amount_per_qty;
            if current <= 0.0 {
                return None;
            }
            let compare_at = match l.compare_at_per_qty {
                Some(c) if c > 0.0 => c,
                _ => current,
            };
            if compare_at < current {
                return None; // invalid compare-at → skip
            }
            let per_item = if percentage {
                let desired_final = compare_at * (1.0 - tier_key / 100.0);
                (current - desired_final).max(0.0)
            } else {
                tier_key.min(current) // amount type
            };
            let total = (per_item * l.quantity as f64 * 100.0).round() / 100.0;
            Some(Candidate {
                message: message.to_string(),
                target_ids: vec![l.id.clone()],
                value: DiscountValue::FixedAmountStr(format_num(total)),
            })
        })
        .collect()
}
