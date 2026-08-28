use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

// The tier discount is PRODUCT-class only. The delivery target is a plumbed
// no-op (empty-safe) so future shipping rules slot in without re-architecting.
#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    _input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] })
}
