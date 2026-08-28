use super::schema;
use discount_tier::config::{parse_tier_config, PriorityCode, SelectionStrategy};
use discount_tier::engine::{build_candidates, DiscountValue, Line};
use discount_tier::shared::{current_platform, id_from_gid, platform_allowed, should_yield};
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::HashMap;

fn empty() -> schema::CartLinesDiscountsGenerateRunResult {
    schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    use schema::cart_lines_discounts_generate_run as q;

    // Only emit PRODUCT-class candidates, and only when the discount was granted it.
    let has_product = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Product);
    if !has_product {
        return Ok(empty());
    }

    // Fail-safe config parse.
    let raw_cfg = input.discount().metafield().map(|m| m.value().as_str());
    let cfg = match parse_tier_config(raw_cfg) {
        Some(c) => c,
        None => return Ok(empty()),
    };

    // Discount-code yield (automatic-vs-code-triggered; prefix/suffix/exact).
    let triggering = input.triggering_discount_code().map(|s| s.as_str());
    let cart_code = input
        .cart()
        .discount_code()
        .and_then(|a| a.value())
        .map(|s| s.as_str());
    let codes: Vec<PriorityCode> = input
        .shop()
        .metafield()
        .and_then(|m| serde_json::from_str(m.value()).ok())
        .unwrap_or_default();
    if should_yield(triggering, cart_code, &codes) {
        return Ok(empty());
    }

    // Platform gate.
    let platform_attr = input
        .cart()
        .platform()
        .and_then(|a| a.value())
        .map(|s| s.as_str());
    if !platform_allowed(cfg.platform, current_platform(platform_attr)) {
        return Ok(empty());
    }

    // Map cart lines onto the engine's Line, keeping a lookup back to the schema ID.
    let mut id_lookup = HashMap::new();
    let mut lines: Vec<Line> = Vec::new();
    for line in input.cart().lines() {
        let id_str = line.id().to_string();
        id_lookup.insert(id_str.clone(), line.id().clone());

        let (variant_id, product_id) = match line.merchandise() {
            q::input::cart::lines::Merchandise::ProductVariant(pv) => (
                id_from_gid(&pv.id().to_string()),
                id_from_gid(&pv.product().id().to_string()),
            ),
            _ => (None, None),
        };

        let amount_per_qty = line.cost().amount_per_quantity().amount().0;
        let subtotal = line.cost().subtotal_amount().amount().0;
        let compare_at_per_qty = line.cost().compare_at_amount_per_quantity().map(|m| m.amount().0);
        let quantity = (*line.quantity()).max(0) as u32;

        lines.push(Line {
            id: id_str,
            quantity,
            variant_id,
            product_id,
            subtotal,
            amount_per_qty,
            compare_at_per_qty,
        });
    }

    let candidates = build_candidates(&cfg, &lines);
    if candidates.is_empty() {
        return Ok(empty());
    }

    let selection_strategy = match cfg.selection_strategy {
        SelectionStrategy::All => schema::ProductDiscountSelectionStrategy::All,
        SelectionStrategy::First => schema::ProductDiscountSelectionStrategy::First,
        SelectionStrategy::Maximum => schema::ProductDiscountSelectionStrategy::Maximum,
    };

    let out_candidates = candidates
        .into_iter()
        .map(|c| {
            let targets = c
                .target_ids
                .iter()
                .filter_map(|sid| id_lookup.get(sid).cloned())
                .map(|id| {
                    schema::ProductDiscountCandidateTarget::CartLine(schema::CartLineTarget {
                        id,
                        quantity: None,
                    })
                })
                .collect();
            let value = match c.value {
                DiscountValue::Percentage(v) => {
                    schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(v),
                    })
                }
                DiscountValue::FixedAmountNum(v) => {
                    schema::ProductDiscountCandidateValue::FixedAmount(
                        schema::ProductDiscountCandidateFixedAmount {
                            amount: Decimal(v),
                            applies_to_each_item: Some(false),
                        },
                    )
                }
                DiscountValue::FixedAmountStr(s) => {
                    schema::ProductDiscountCandidateValue::FixedAmount(
                        schema::ProductDiscountCandidateFixedAmount {
                            amount: Decimal(s.parse::<f64>().unwrap_or(0.0)),
                            applies_to_each_item: Some(false),
                        },
                    )
                }
            };
            schema::ProductDiscountCandidate {
                targets,
                message: Some(c.message),
                value,
                associated_discount_code: None,
                prerequisites: None,
            }
        })
        .collect();

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy,
                candidates: out_candidates,
            },
        )],
    })
}
