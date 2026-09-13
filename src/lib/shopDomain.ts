import { eq } from 'drizzle-orm';
import type { createDb } from '../db/db';
import { shopifyShop } from '../db/schema';

/**
 * Resolves the caller's `*.myshopify.com` domain (needed to call the Admin
 * API) from its app-internal shopId. Fails loudly rather than masking a
 * missing domain — a shop row without one is a data-integrity bug, not a
 * recoverable state.
 */
export async function requireShopDomain(
  db: ReturnType<typeof createDb>,
  shopId: string,
): Promise<string> {
  const shop = await db
    .select({ domain: shopifyShop.myshopifyDomain })
    .from(shopifyShop)
    .where(eq(shopifyShop.id, shopId))
    .get();
  if (!shop?.domain) {
    throw new Error(`[shopDomain] no myshopify domain on file for shopId=${shopId}`);
  }
  return shop.domain;
}
