import { adminGraphql } from './graphqlAdmin';
import type { Env } from '../types/env';

/**
 * Deleting an app discount from Shopify.
 *
 * The first code in this app that DELETES merchant data rather than adding to
 * it. There is no undo in Shopify, so every failure path here fails loudly:
 * a caller is about to drop its own record of the discount, and must never do
 * that on the strength of a delete that did not actually happen.
 */

const AUTOMATIC_DELETE = `
  mutation DeleteAutomaticAppDiscount($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }
`;

const CODE_DELETE = `
  mutation DeleteCodeAppDiscount($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message }
    }
  }
`;

interface DeletePayload {
  deletedAutomaticDiscountId?: string | null;
  deletedCodeDiscountId?: string | null;
  userErrors: Array<{ field: string[] | null; message: string }>;
}

/**
 * `method` picks the mutation, and the two are not interchangeable: sending
 * the automatic delete for a code discount deletes nothing and reports no
 * error, which would leave the discount live in the store while the caller
 * believed it gone.
 */
export async function deleteDiscountInShopify(
  env: Env,
  shopDomain: string,
  shopifyGid: string,
  method: 'automatic' | 'code',
): Promise<void> {
  const mutation = method === 'code' ? CODE_DELETE : AUTOMATIC_DELETE;
  const field = method === 'code' ? 'discountCodeDelete' : 'discountAutomaticDelete';

  const res = await adminGraphql<Record<string, DeletePayload>>(
    shopDomain, env, mutation, { id: shopifyGid },
  );

  if (res.errors && res.errors.length > 0) {
    throw new Error(`[deleteDiscount] ${shopifyGid}: ${JSON.stringify(res.errors)}`);
  }

  const payload = res.data?.[field];
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`[deleteDiscount] ${shopifyGid}: ${userErrors.map((e) => e.message).join('; ')}`);
  }

  const deletedId = payload?.deletedAutomaticDiscountId ?? payload?.deletedCodeDiscountId;
  // No id and no error means Shopify neither deleted it nor said why. Treating
  // that as success would let the caller delete the campaign row that holds
  // the only reference to a discount still live in the merchant's store.
  if (!deletedId) {
    throw new Error(`[deleteDiscount] ${shopifyGid}: Shopify returned no deleted id`);
  }
}
