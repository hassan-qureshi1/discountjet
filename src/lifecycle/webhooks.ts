import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../types/env';
import { timingSafeEqual } from '../lib/timingSafeEqual';
import { createDb } from '../db/db';
import { shopifyShop } from '../db/schema';
import { syncDiscountFromWebhook, type DiscountWebhookPayload } from './discountSync';

// Starter registers only APP_UNINSTALLED. To register more topics, add to this
// list and to the dispatch switch in the webhook handler below. Common topics:
//   'products/create', 'products/update', 'products/delete',
//   'orders/create', 'orders/updated', 'orders/cancelled',
//   'collections/create', 'collections/update', 'collections/delete',
//   'app/uninstalled',
//   'customers/data_request', 'customers/redact', 'shop/redact'  // GDPR
const WEBHOOK_TOPICS = [
  'app/uninstalled',
  // E4: mirror Shopify discounts into D1 for the app Discounts list/detail.
  'discounts/create',
  'discounts/update',
  'discounts/delete',
] as const;

// SECURITY AUDIT 2026-08-16: verified safe — this is outbound webhook REGISTRATION via Shopify Admin API (authenticated by X-Shopify-Access-Token header), not an inbound webhook handler. HMAC verification lives in handleWebhook below.
export async function registerWebhooks(
  shopDomain: string,
  accessToken: string,
  env: Env
): Promise<void> {
  const webhookEndpoint = `https://${env.HOST}/shopify/webhooks`;

  for (const topic of WEBHOOK_TOPICS) {
    try {
      const res = await fetch(
        `https://${shopDomain}/admin/api/2026-04/webhooks.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({
            webhook: {
              topic,
              address: webhookEndpoint,
              format: 'json',
            },
          }),
        }
      );
      // 422 = already registered, that's fine
      if (!res.ok && res.status !== 422) {
        console.error(`Failed to register webhook ${topic}: ${res.status}`);
      }
    } catch (err) {
      console.error(`Error registering webhook ${topic}:`, err);
    }
  }
}

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();

  // Verify HMAC signature
  const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
  const secret = c.env.SHOPIFY_API_SECRET;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computedHmac = btoa(String.fromCharCode(...new Uint8Array(signature)));

  if (!timingSafeEqual(computedHmac, hmacHeader)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const topic = c.req.header('X-Shopify-Topic') ?? '';
  const shopDomain = c.req.header('X-Shopify-Shop-Domain') ?? '';

  // Starter: handle inline. Add queue routing here when you wire up Cloudflare Queues.
  if (topic === 'app/uninstalled') {
    const { onShopUninstall } = await import('./uninstall');
    await onShopUninstall(shopDomain, c.env);
  } else if (topic.startsWith('discounts/')) {
    await handleDiscountWebhook(c, topic, shopDomain, rawBody);
  }

  return c.json({ ok: true });
}

// Dispatch a discounts/{create,update,delete} webhook into the D1 sync module.
// Resolves the shop row, then delegates to `syncDiscountFromWebhook` (idempotency
// gate + hydrate/classify/upsert or tombstone). Failures are logged, not thrown —
// returning 200 avoids Shopify redelivery storms; the reconcile pass closes gaps.
async function handleDiscountWebhook(
  c: Context<{ Bindings: Env }>,
  topic: string,
  shopDomain: string,
  rawBody: string,
): Promise<void> {
  try {
    const db = createDb(c.env.DB);
    const shop = await db
      .select({ id: shopifyShop.id })
      .from(shopifyShop)
      .where(eq(shopifyShop.myshopifyDomain, shopDomain))
      .get();
    if (!shop?.id) {
      console.error(`[discountSync] no installed shop for ${shopDomain}`);
      return;
    }

    const deliveryId = c.req.header('X-Shopify-Webhook-Id') ?? crypto.randomUUID();
    const payload = JSON.parse(rawBody) as DiscountWebhookPayload;

    await syncDiscountFromWebhook({
      db,
      env: c.env,
      shopId: shop.id,
      shopDomain,
      topic,
      deliveryId,
      payload,
    });
  } catch (err) {
    console.error(`[discountSync] failed for ${shopDomain} ${topic}:`, err);
  }
}

const webhookApp = new Hono<{ Bindings: Env }>();
webhookApp.post('/shopify/webhooks', handleWebhook);

export { webhookApp as webhookRoutes };
