import { adminGraphql } from './graphqlAdmin';
import { getAdapter } from './discountEngines/adapters';
import { CAMPAIGN_METAFIELD_KEY } from './discountEngines/campaignLock';
import type { DiscountEngineType } from './discountEngines/adapters';
import { resolveDiscountFunctionId } from './discountFunctions';
import type { Env } from '../types/env';

const DISCOUNT_AUTOMATIC_APP_CREATE = /* GraphQL */ `
  mutation CreateAppDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const DISCOUNT_CODE_APP_CREATE = /* GraphQL */ `
  mutation CreateAppCodeDiscount($discount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $discount) {
      codeAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

interface DiscountCreateResult {
  discountAutomaticAppCreate?: {
    automaticAppDiscount: { discountId: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
  discountCodeAppCreate?: {
    codeAppDiscount: { discountId: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
}

export interface CreateDiscountRequest {
  engineType: DiscountEngineType;
  form: unknown;
  method: 'automatic' | 'code';
  /** Used when `method` is 'automatic'. A code discount is titled by its code. */
  title?: string;
  /** Required when `method` is 'code'. */
  code?: string;
  startsAt: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
  /**
   * The campaign that created this discount, when one did.
   *
   * Written as a SEPARATE metafield rather than a field inside the engine
   * config: that config is deserialised by the deployed Rust functions on
   * every cart and carries a 10 KB cap, so a key added there risks a function
   * that prices real carts. A key here cannot — no function reads it.
   *
   * Its only consumer is the discount's settings extension in Shopify admin,
   * which disables its fields when the value is present. A campaign owns its
   * discounts' configuration for the same reason it owns its bundles'
   * schedule: editing one half behind the other's back desynchronises them
   * with nothing in either place saying so.
   */
  campaignId?: string;
}

export type CreateDiscountOutcome =
  | { ok: true; discountId: string; value: string; sizeBytes: number }
  | { ok: false; status: 400 | 502; error: string };

/**
 * Create one discount in Shopify from a form, and return the outcome.
 *
 * Shared by `POST /api/discounts` and campaign publish, so both run identical
 * validation, serialisation and mutation logic. A second copy would drift, and
 * what drifts here is the configuration a Rust function reads to price a cart.
 *
 * Returns an outcome rather than throwing: the route maps it to a status, while
 * publish records it against one row and carries on to the next discount.
 */
export async function createDiscountInShopify(
  env: Env,
  shopDomain: string,
  req: CreateDiscountRequest,
): Promise<CreateDiscountOutcome> {
  /**
   * Shopify's own admin titles a code discount with its code, and the discounts
   * list — ours and theirs — shows that title. Letting the two differ would name
   * the same promotion two ways depending on which screen the merchant is on, so
   * the code wins and any title sent alongside it is ignored rather than
   * silently half-used.
   */
  const title = req.method === 'code' ? req.code!.trim() : req.title!.trim();

  const adapter = getAdapter(req.engineType);
  const form = req.form as never;

  const errors = adapter.validate(form);
  if (errors.length > 0) return { ok: false, status: 400, error: errors.join(' ') };

  let value: string;
  try {
    value = adapter.serialize(form);
  } catch (err) {
    return { ok: false, status: 400, error: `Could not build the discount configuration: ${String(err)}` };
  }

  // `validate` passed on the FORM, but the builder drops rules it cannot
  // resolve (e.g. a `product_id` tier whose items only carry `variantId`).
  // Without this the mutation succeeds and the merchant gets a live promotion
  // that does nothing at checkout, with no error anywhere.
  if (!adapter.isActionable(JSON.parse(value))) {
    return {
      ok: false,
      status: 400,
      error:
        'This promotion has no usable rules. Check that each tier has products selected and a numeric discount value.',
    };
  }

  const sizeBytes = new TextEncoder().encode(value).length;
  if (sizeBytes > adapter.maxBytes) {
    return {
      ok: false,
      status: 400,
      error: `Discount configuration is too large (${(sizeBytes / 1024).toFixed(1)}KB). Maximum size is 10KB.`,
    };
  }

  let functionId: string;
  try {
    functionId = await resolveDiscountFunctionId(env, shopDomain, adapter.functionHandle);
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }

  // Everything except the trigger is shared: same engine, same functionId, same
  // serialised config. The Rust function neither knows nor cares whether a code
  // or the cart brought it into play.
  const shared = {
    title,
    functionId,
    // BOTH mutations require this — Shopify rejects either with "Functions
    // configured to use the `discounts` API type require the discountClasses
    // field to be set." The 2026-04 docs say `DiscountCodeAppInput` does not
    // take it; verified against a real store, it does. Comes from the adapter
    // because it is a property of what that function emits.
    discountClasses: adapter.discountClasses,
    startsAt: req.startsAt,
    ...(req.endsAt ? { endsAt: req.endsAt } : {}),
    ...(req.combinesWith ? { combinesWith: req.combinesWith } : {}),
    metafields: [
      { namespace: adapter.namespace, key: adapter.key, type: 'json', value },
      // Same namespace as the engine's own config, so it travels with it and
      // needs no second reserved prefix; a distinct key so the two never
      // collide. A bare id, so the honest type is text rather than json —
      // nothing reading this has to parse to know the discount is owned.
      ...(req.campaignId
        ? [{
          namespace: adapter.namespace,
          key: CAMPAIGN_METAFIELD_KEY,
          type: 'single_line_text_field',
          value: req.campaignId,
        }]
        : []),
    ],
  };

  const res = req.method === 'code'
    ? await adminGraphql<DiscountCreateResult>(shopDomain, env, DISCOUNT_CODE_APP_CREATE, {
      discount: { ...shared, code: req.code?.trim() },
    })
    : await adminGraphql<DiscountCreateResult>(shopDomain, env, DISCOUNT_AUTOMATIC_APP_CREATE, {
      discount: shared,
    });

  if (res.errors && res.errors.length > 0) {
    return { ok: false, status: 502, error: `Shopify rejected the discount: ${JSON.stringify(res.errors)}` };
  }

  const payload = req.method === 'code' ? res.data?.discountCodeAppCreate : res.data?.discountAutomaticAppCreate;

  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { ok: false, status: 502, error: userErrors.map((e) => e.message).join(' ') };
  }

  const discountId = payload && 'codeAppDiscount' in payload
    ? payload.codeAppDiscount?.discountId
    : payload?.automaticAppDiscount?.discountId;
  if (!discountId) {
    return { ok: false, status: 502, error: 'Shopify returned no discount id' };
  }

  return { ok: true, discountId, value, sizeBytes };
}
