import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─── shopify_shop ───────────────────────────────────────────────────────────
//
// The single table the starter ships with. Every other table in a real app
// should reference this one via a non-null `shopId` text FK with
// `onDelete: 'cascade'` (the GDPR SHOP_REDACT pattern).
//
// All IDs are `crypto.randomUUID()`. Timestamps are ISO 8601 strings.
//
export const shopifyShop = sqliteTable('shopify_shop', {
  id: text('id').primaryKey(),

  // Custom fields
  installDate: text('install_date'),
  plan: text('plan'),

  // Shopify identifiers / contact
  myshopifyDomain: text('myshopify_domain'),
  domain: text('domain'),
  name: text('name'),
  email: text('email'),
  shopOwner: text('shop_owner'),
  city: text('city'),
  countryName: text('country_name'),
  currency: text('currency'),
  ianaTimezone: text('iana_timezone'),
  primaryLocale: text('primary_locale'),

  status: text('status', { enum: ['installed', 'uninstalled'] }),

  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

// ─── discount ───────────────────────────────────────────────────────────────
//
// App-owned mirror of Shopify discounts (E4). Shopify is the source of truth;
// this table is a queryable copy kept in sync by the `discounts/*` webhooks and
// the backfill/reconcile passes. Only discounts created by THIS app's Functions
// are mirrored — native discounts are read live from Shopify, not persisted.
//
// Upsert key is (shopId, shopifyGid). `type`/`products` come from the `$app:`
// config metafield E3 writes and are nullable/0 until that config is present.
//
export const discount = sqliteTable(
  'discount',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shopifyShop.id, { onDelete: 'cascade' }),

    // The Shopify discount GID (admin_graphql_api_id) — the upsert key.
    shopifyGid: text('shopify_gid').notNull(),

    name: text('name').notNull(),
    // Engine kind, from the $app: config metafield. Null until config present.
    type: text('type', { enum: ['tier', 'bundle', 'special'] }),
    method: text('method', { enum: ['automatic', 'code'] }),
    status: text('status', { enum: ['active', 'inactive'] }),
    // Count of targeted variants parsed from config; 0 when unknown.
    products: integer('products').notNull().default(0),

    // Ownership lock, written by campaigns (E8); read-only here.
    campaignId: text('campaign_id'),

    // Tombstone set by discounts/delete or the reconcile diff.
    deletedAt: text('deleted_at'),

    createdAt: text('created_at'),
    // Mirror of Shopify updated_at; also drives the ordering guard.
    updatedAt: text('updated_at'),
  },
  (t) => ({
    shopGidUnq: uniqueIndex('discount_shop_gid_unq').on(t.shopId, t.shopifyGid),
  }),
);

// ─── webhook_event ──────────────────────────────────────────────────────────
//
// Idempotency + sync-health ledger. `id` is the per-delivery
// `X-Shopify-Webhook-Id` header (unique per delivery), so a re-delivered
// webhook is detected by primary-key conflict and skipped.
//
export const webhookEvent = sqliteTable('webhook_event', {
  id: text('id').primaryKey(),
  topic: text('topic').notNull(),
  shopId: text('shop_id'),
  shopifyGid: text('shopify_gid'),
  receivedAt: text('received_at').notNull(),
});
