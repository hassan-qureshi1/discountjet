use super::schema;
use cart_transformer::config::{parse_discount_engine_config, parse_merge_bundle_config};
use cart_transformer::orchestrator;
use cart_transformer::shared::{has_priority_discount_code, id_from_gid, CartLine, CartOp};
use shopify_function::prelude::*;
use shopify_function::Result;

fn empty() -> schema::CartTransformRunResult {
    schema::CartTransformRunResult { operations: vec![] }
}

#[shopify_function]
fn cart_transform_run(
    input: schema::cart_transform_run::Input,
) -> Result<schema::CartTransformRunResult> {
    use schema::cart_transform_run as q;

    // ── Guard: priority discount code suppresses all transformations ──────
    let cart_code = input.cart().discount_code().and_then(|a| a.value()).map(|s| s.as_str());
    let priority_codes_raw = input.shop().priority_codes().map(|m| m.value().as_str());
    if has_priority_discount_code(cart_code, priority_codes_raw) {
        return Ok(empty());
    }

    // ── Guard: empty cart — nothing to expand or transform ────────────────
    let raw_lines = input.cart().lines();
    if raw_lines.is_empty() {
        return Ok(empty());
    }

    // Build pure `CartLine` structs, keeping a lookup back to the generated
    // cart-line ID so the output can reference the original line objects.
    let mut id_lookup: std::collections::HashMap<String, schema::Id> = std::collections::HashMap::new();
    let mut lines: Vec<CartLine> = Vec::with_capacity(raw_lines.len());
    for line in raw_lines {
        let id_str = line.id().to_string();
        id_lookup.insert(id_str.clone(), line.id().clone());

        let (is_pv, variant_gid, variant_id, product_title, composition) = match line.merchandise() {
            q::input::cart::lines::Merchandise::ProductVariant(pv) => {
                let gid = pv.id().to_string();
                let vid = id_from_gid(&gid);
                let title = pv.product().title().to_string();
                let composition = pv.composition().map(|m| m.value().to_string());
                (true, Some(gid), vid, Some(title), composition)
            }
            _ => (false, None, None, None, None),
        };

        lines.push(CartLine {
            id: id_str,
            is_product_variant: is_pv,
            variant_gid,
            variant_id,
            product_title,
            composition,
            amount_per_quantity: Some(line.cost().amount_per_quantity().amount().to_string()),
            subtotal_amount: Some(line.cost().subtotal_amount().amount().to_string()),
            quantity: *line.quantity() as i64,
        });
    }

    // ── Parse shop `checkout.discount_engine` config for Pass 2 ────────────
    let raw_config = input.shop().metafield().map(|m| m.value().as_str());
    let configs = parse_discount_engine_config(raw_config);

    // ── Parse shop `checkout.merge_bundles` config for Pass 3 ──────────────
    let raw_merge_config = input.shop().merge_bundles().map(|m| m.value().as_str());
    let merge_configs = parse_merge_bundle_config(raw_merge_config);

    // ── Platform source (cart attribute; default CHECKOUT) ─────────────────
    let platform_attr =
        input.cart().platform_source().and_then(|a| a.value()).map(|s| s.as_str());

    let operations = orchestrator::transform(&lines, &configs, &merge_configs, platform_attr)?;

    let out_operations = operations.into_iter().map(|op| build_operation(op, &id_lookup)).collect();

    Ok(schema::CartTransformRunResult { operations: out_operations })
}

fn build_operation(
    op: CartOp,
    id_lookup: &std::collections::HashMap<String, schema::Id>,
) -> schema::Operation {
    match op {
        CartOp::Expand(op) => build_expand_operation(op, id_lookup),
        CartOp::Merge(op) => build_merge_operation(op, id_lookup),
    }
}

fn build_expand_operation(
    op: cart_transformer::shared::LineExpandOp,
    id_lookup: &std::collections::HashMap<String, schema::Id>,
) -> schema::Operation {
    let cart_line_id = id_lookup
        .get(&op.cart_line_id)
        .cloned()
        .unwrap_or_else(|| op.cart_line_id.clone());

    let expanded_cart_items = op
        .expanded_items
        .into_iter()
        .map(|item| schema::ExpandedItem {
            attributes: if item.attributes.is_empty() {
                None
            } else {
                Some(
                    item.attributes
                        .into_iter()
                        .map(|(key, value)| schema::AttributeOutput { key, value })
                        .collect(),
                )
            },
            merchandise_id: item.merchandise_id,
            price: item.price_amount.map(|amount| schema::ExpandedItemPriceAdjustment {
                adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
                    schema::ExpandedItemFixedPricePerUnitAdjustment {
                        amount: Decimal(amount.parse::<f64>().unwrap_or(0.0)),
                    },
                ),
            }),
            quantity: item.quantity as i32,
        })
        .collect();

    schema::Operation::LineExpand(schema::LineExpandOperation {
        cart_line_id,
        expanded_cart_items,
        image: None,
        price: None,
        title: op.title,
    })
}

fn build_merge_operation(
    op: cart_transformer::shared::LinesMergeOp,
    id_lookup: &std::collections::HashMap<String, schema::Id>,
) -> schema::Operation {
    let cart_lines = op
        .cart_lines
        .into_iter()
        .map(|(line_id, quantity)| {
            let cart_line_id =
                id_lookup.get(&line_id).cloned().unwrap_or_else(|| line_id.clone());
            schema::CartLineInput { cart_line_id, quantity: quantity as i32 }
        })
        .collect();

    schema::Operation::LinesMerge(schema::LinesMergeOperation {
        attributes: None,
        cart_lines,
        image: None,
        parent_variant_id: op.parent_variant_id,
        price: Some(schema::PriceAdjustment {
            percentage_decrease: Some(schema::PriceAdjustmentValue {
                value: Decimal(op.percentage_decrease),
            }),
        }),
        title: op.title,
    })
}
