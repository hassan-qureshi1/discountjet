import type { Context } from 'hono';
import type { AppEnv } from '../types/env.d';

/**
 * Reads the caller's `*.myshopify.com` domain (needed to call the Admin API)
 * off the request context, where `requireShop` put it during auth — no query.
 * Fails loudly rather than masking a missing domain: a shop row without one is
 * a data-integrity bug, not a recoverable state.
 */
export function requireShopDomain(c: Context<AppEnv>): string {
  const domain = c.get('shopDomain');
  if (!domain) {
    throw new Error(`[shopDomain] no myshopify domain on file for shopId=${c.get('shopId')}`);
  }
  return domain;
}
