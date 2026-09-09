import type { Env } from '../types/env';
import { registerWebhooks } from './webhooks';
import { backfillDiscounts } from './discountSync';
import { ensureCartTransform } from '../lib/cartTransformRegistration';
import { ensureCartTransformMetafieldDefinitions } from '../lib/metafieldDefinitions';
import { createDb } from '../db/db';
import { shopifyShop } from '../db/schema';
import { eq } from 'drizzle-orm';

// Called from src/routes/auth.ts after Shopify OAuth completes.
// The starter ships with the minimum: hydrate the shop row, register webhooks.
// Add Slack pings, welcome emails, seed settings, sync enqueues here in your app.
export async function onShopInstall(
  shopDomain: string,
  session: { shop: string; accessToken: string; id: string },
  env: Env,
): Promise<void> {
  const now = new Date().toISOString();
  const db = createDb(env.DB);

  // 1. Fetch shop details from Shopify REST.
  let name = '';
  let email = '';
  let city = '';
  let countryName = '';
  let domain = '';
  let shopOwner = '';
  let currency = '';
  let ianaTimezone = '';
  let primaryLocale = '';
  let plan = '';

  try {
    const res = await fetch(`https://${shopDomain}/admin/api/2026-04/shop.json`, {
      headers: { 'X-Shopify-Access-Token': session.accessToken },
    });
    if (res.ok) {
      const data = await res.json<{ shop: Record<string, string> }>();
      name = data.shop.name ?? '';
      email = data.shop.email ?? '';
      city = data.shop.city ?? '';
      countryName = data.shop.country_name ?? '';
      domain = data.shop.domain ?? '';
      shopOwner = data.shop.shop_owner ?? '';
      currency = data.shop.currency ?? '';
      ianaTimezone = data.shop.iana_timezone ?? '';
      primaryLocale = data.shop.primary_locale ?? '';
      plan = data.shop.plan_display_name ?? '';
    } else {
      console.error(`[install] shop.json fetch failed: ${res.status} ${res.statusText} for ${shopDomain}`);
    }
  } catch (err) {
    console.error(`[install] shop.json fetch threw for ${shopDomain}:`, err);
  }

  // 2. Upsert shop row.
  await db
    .update(shopifyShop)
    .set({
      name,
      email,
      city,
      countryName,
      domain,
      shopOwner,
      currency,
      ianaTimezone,
      primaryLocale,
      plan,
      installDate: now,
      status: 'installed',
      updatedAt: now,
    })
    .where(eq(shopifyShop.myshopifyDomain, shopDomain));

  // 3. Register webhooks with Shopify.
  // Starter only registers APP_UNINSTALLED. Add more topics in src/lifecycle/webhooks.ts.
  await registerWebhooks(shopDomain, session.accessToken, env);

  // 4. Backfill the discount mirror (E4-5). Webhooks only cover changes after
  // install, so seed the mirror with existing app-owned discounts now. Best-effort:
  // a failure here (e.g. token not yet readable) is recoverable via reconcile.
  let shopRow: { id: string } | null | undefined;
  try {
    shopRow = await db
      .select({ id: shopifyShop.id })
      .from(shopifyShop)
      .where(eq(shopifyShop.myshopifyDomain, shopDomain))
      .get();
    if (shopRow?.id) {
      await backfillDiscounts({ db, env, shopId: shopRow.id, shopDomain });
    }
  } catch (err) {
    console.error(`[install] discount backfill failed for ${shopDomain}:`, err);
  }

  // 5. Register the cart-transform function (E6). Best-effort: a failure
  // here (e.g. the function not yet deployed) is recoverable — the
  // activation-status endpoint retries this on next load.
  try {
    if (shopRow?.id) {
      const result = await ensureCartTransform(env, shopDomain, db, shopRow.id);
      if ('conflict' in result) {
        console.error(`[install] cart transform registration conflict for ${shopDomain}: a foreign transform already exists`);
      } else {
        console.log(
          `[install] cart transform ${result.created ? 'created' : 'adopted'} for ${shopDomain}: ${result.gid}`,
        );
      }
    }
  } catch (err) {
    console.error(`[install] cart transform registration failed for ${shopDomain}:`, err);
  }

  // 6. Create the `$app:cart-transform` metafield definitions (E6). Non-fatal:
  // a definition only controls admin visibility/read-only-ness — the
  // underlying metafield reads/writes work regardless of whether it exists —
  // so a failure here must never fail install.
  try {
    await ensureCartTransformMetafieldDefinitions(env, shopDomain);
  } catch (err) {
    console.error(`[install] cart-transform metafield definition creation failed for ${shopDomain}:`, err);
  }
}
