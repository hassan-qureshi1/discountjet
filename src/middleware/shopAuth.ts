import type { Context } from 'hono';
import type { AppEnv } from '../types/env.d';
import type { IShopRepository, ShopIdentity } from '../db/repositories';
import { RequestedTokenType } from '@shopify/shopify-api';
import { createShopify, createSessionStorage } from '../shopify';

// Refresh the offline token when within 5 minutes of expiry — matches Shopify's own library.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Resolves the current shop from the request.
 * Priority: Authorization JWT (signature-verified) → shop query param
 *           / x-shop-domain (local dev only).
 * Returns null if not found or shop is not installed.
 *
 * Returns the whole identity (id + myshopify domain) rather than just the id:
 * nearly every handler that needs the id also needs the domain to call the
 * Admin API, and this lookup already has the row in hand. `requireShop`
 * stashes both on the context so no handler re-queries for the domain.
 */
export async function getCurrentShop(
  c: Context<AppEnv>,
  shops: IShopRepository,
): Promise<ShopIdentity | null> {

  // 1. Shopify session token (App Bridge useAuthenticatedFetch)
  // decodeSessionToken verifies the HMAC-SHA256 signature using SHOPIFY_API_SECRET
  // and validates exp/nbf/aud claims — a forged or expired token throws here.
  const authHeader = c.req.header('authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const shopify = createShopify(c.env);
      const payload = await shopify.session.decodeSessionToken(token);
      const shopDomain = new URL(payload.dest).hostname;

      // Token exchange: if the stored offline access token is missing or near expiry,
      // use the live App Bridge JWT to get a fresh one from Shopify.
      // expiring:true requests a refresh_token alongside the access token so
      // background workers (cron, queues) can rotate it without a JWT.
      const sessionStorage = createSessionStorage(c.env);
      const existing = await sessionStorage.loadSession(`offline_${shopDomain}`);
      if (!existing || !existing.isActive(undefined, EXPIRY_BUFFER_MS)) {
        try {
          const { session: fresh } = await shopify.auth.tokenExchange({
            shop: shopDomain,
            sessionToken: token,
            requestedTokenType: RequestedTokenType.OfflineAccessToken,
            expiring: true,
          });
          await sessionStorage.storeSession(fresh);
          console.log(`[shopAuth] token exchange succeeded for ${shopDomain}, expires=${fresh.expires?.toISOString()}`);
        } catch (exchangeErr) {
          console.error(`[shopAuth] token exchange failed for ${shopDomain}:`, exchangeErr);
          // Non-fatal: if we had an existing (even near-expiry) token, it may still work.
        }
      }

      const row = await shops.findInstalledByDomain(shopDomain);
      if (row) return row;
    } catch (err) {
      console.error(`[shopAuth] JWT verification failed:`, err);
      // invalid/expired token — fall through
    }
  }

  // 2. Local-dev fallbacks ONLY — never trusted in production.
  // An unverified shop identifier (query param or header) in production would
  // let any caller who knows a merchant's .myshopify.com domain bypass auth on
  // all /api/* routes. Webhooks verify HMAC independently and never reach here.
  const isLocalDev = c.env.ENVIRONMENT === 'development';
  const shopDomain = isLocalDev
    ? (c.req.query('shop') ?? c.req.header('x-shop-domain'))
    : null;

  if (!shopDomain) return null;

  return shops.findInstalledByDomain(shopDomain);
}
