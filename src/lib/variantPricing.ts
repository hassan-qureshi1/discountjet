import { adminGraphql } from './graphqlAdmin';
import { toMinorUnits, toMoney } from './money';
import type { Env } from '../types/env';

const VARIANT_PRICE_QUERY = `
  query BundleVariantPrice($id: ID!) {
    productVariant(id: $id) { id price product { id } }
    shop { currencyCode }
  }
`;

const VARIANT_PRICE_MUTATION = `
  mutation SetBundleVariantPricing($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface VariantPriceResponse {
  productVariant: { id: string; price: string; product: { id: string } } | null;
  shop: { currencyCode: string };
}

/** Minor units, so it can be stored and compared without float drift. */
export async function readVariantPrice(
  env: Env,
  shopDomain: string,
  variantGid: string,
): Promise<{ priceMinor: number; currencyCode: string } | null> {
  const res = await adminGraphql<VariantPriceResponse>(
    shopDomain, env, VARIANT_PRICE_QUERY, { id: variantGid },
  );
  if (res.errors && res.errors.length > 0) {
    throw new Error(`[readVariantPrice] ${variantGid}: ${JSON.stringify(res.errors)}`);
  }
  const node = res.data?.productVariant;
  // Deleted in Shopify: report absence rather than inventing a price, so the
  // caller records a reason instead of pricing against a guess.
  if (!node) return null;
  const currencyCode = res.data!.shop.currencyCode;
  return { priceMinor: toMinorUnits(node.price, currencyCode), currencyCode };
}

export async function setVariantPricing(
  env: Env,
  shopDomain: string,
  variantGid: string,
  values: { priceMinor: number; compareAtMinor: number; currencyCode: string },
): Promise<void> {
  const current = await adminGraphql<VariantPriceResponse>(
    shopDomain, env, VARIANT_PRICE_QUERY, { id: variantGid },
  );
  if (current.errors && current.errors.length > 0) {
    throw new Error(`[setVariantPricing] ${variantGid}: ${JSON.stringify(current.errors)}`);
  }
  const productId = current.data?.productVariant?.product.id;
  if (!productId) {
    throw new Error(`[setVariantPricing] ${variantGid} no longer exists in Shopify`);
  }

  const res = await adminGraphql<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string }> | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(shopDomain, env, VARIANT_PRICE_MUTATION, {
    productId,
    variants: [{
      id: variantGid,
      price: toMoney(values.priceMinor, values.currencyCode)!.amount,
      compareAtPrice: toMoney(values.compareAtMinor, values.currencyCode)!.amount,
    }],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(`[setVariantPricing] ${variantGid}: ${JSON.stringify(res.errors)}`);
  }
  const userErrors = res.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`[setVariantPricing] ${variantGid}: ${userErrors.map((e) => e.message).join('; ')}`);
  }
  // Fail loudly on a response that reports neither an error nor a write: the
  // caller is about to record a price change that may not have happened.
  if (!res.data?.productVariantsBulkUpdate?.productVariants?.length) {
    throw new Error(`[setVariantPricing] ${variantGid}: no variant returned`);
  }
}
