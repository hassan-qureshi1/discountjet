use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

// Bundle discounts are PRODUCT-class only; delivery target is a plumbed no-op.
#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    _input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] })
}
