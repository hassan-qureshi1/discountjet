use super::schema;
use discount_special::config::{parse_special_config, PriorityCode};
use discount_special::engine::{build_candidates, DiscountValue, Line};
use discount_special::shared::{current_platform, id_from_gid, should_yield};
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

    let has_product = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Product);
    if !has_product {
        return Ok(empty());
    }

    let raw_cfg = input.discount().metafield().map(|m| m.value().as_str());
    let cfg = match parse_special_config(raw_cfg) {
        Some(c) => c,
        None => return Ok(empty()),
    };

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

    let platform_attr = input
        .cart()
        .platform()
        .and_then(|a| a.value())
        .map(|s| s.as_str());
    let current = current_platform(platform_attr);

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

        lines.push(Line {
            id: id_str,
            quantity: (*line.quantity()).max(0) as u32,
            variant_id,
            product_id,
            subtotal: line.cost().subtotal_amount().amount().0,
            amount_per_qty: line.cost().amount_per_quantity().amount().0,
            compare_at_per_qty: line.cost().compare_at_amount_per_quantity().map(|m| m.amount().0),
        });
    }

    let candidates = build_candidates(&cfg, &lines, current);
    if candidates.is_empty() {
        return Ok(empty());
    }

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
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates: out_candidates,
            },
        )],
    })
}
