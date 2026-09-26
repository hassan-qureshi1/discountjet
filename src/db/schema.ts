import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

  // Plan-signal cache (E6-2) — populated on first `/api/shop/plan` read from
  // Admin GraphQL `shop { plan { ... } } ` and served from cache thereafter.
  // Booleans stored as 0/1 (SQLite has no native boolean type); null means
  // "not yet queried".
  shopifyPlus: integer('shopify_plus'),
  partnerDevelopment: integer('partner_development'),
  planName: text('plan_name'),

  // Cart Transform GID (E6) — Shopify Functions cart transform admin_graphql_api_id
  cartTransformGid: text('cart_transform_gid'),

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

// ─── bundle ─────────────────────────────────────────────────────────────────
//
// E6 bundles. Each row is an app-owned bundle definition — the `items` JSON
// list of components is materialized into a Shopify Cart Transform Function
// config and, once live, a variant metafield (`metafieldState`/`metafieldGid`
// track that write). Shopify is not the source of truth here; this table is.
//
export const bundle = sqliteTable(
  'bundle',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shopifyShop.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    operation: text('operation', { enum: ['merge', 'expand', 'update'] }).notNull(),

    parentVariantId: text('parent_variant_id'),
    price: integer('price'), // minor units

    metafieldState: text('metafield_state', { enum: ['NotYet', 'Written', 'Cleared'] })
      .notNull()
      .default('NotYet'),
    metafieldGid: text('metafield_gid'),

    scheduleStart: text('schedule_start'),
    scheduleEnd: text('schedule_end'),
    status: text('status', { enum: ['Active', 'Scheduled', 'Ended', 'Draft'] }).notNull(),
    blockOnFailure: integer('block_on_failure').notNull().default(0),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    shopIdIdx: index('bundle_shop_id_idx').on(t.shopId),
  }),
);

// ─── bundle_item ────────────────────────────────────────────────────────────
//
// One row per bundle component — the normalized form of what used to be
// `bundle.items` JSON. The bundle's total is NOT stored: it is
// `sum(price * qty)` over these rows, so it cannot disagree with them.
//
// `shopId` is redundant (reachable via `bundleId`) and deliberately so: it is
// what lets BundleItemRepository extend ShopScopedRepository and inherit
// `where shop_id = ?` on every read and write.
//
// There is no `position` column. The editor has no reorder UI, so order is
// whatever the resource picker returned; items are listed by `name` instead.
//
export const bundleItem = sqliteTable(
  'bundle_item',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shopifyShop.id, { onDelete: 'cascade' }),
    bundleId: text('bundle_id')
      .notNull()
      .references(() => bundle.id, { onDelete: 'cascade' }),

    variantId: text('variant_id').notNull(), // ProductVariant GID

    // Snapshot of the variant's title at save time. READ ONLY when the variant
    // fails to resolve against Shopify — a live variant's name always comes
    // from the Admin API so a rename shows up immediately. It exists so the
    // editor can name a DELETED variant, which Shopify returns nothing for.
    name: text('name').notNull(),

    qty: integer('qty').notNull(),
    price: integer('price').notNull(), // per-unit, minor units

    // `update`-operation only; stored but not currently read by any metafield.
    priceAdjustment: integer('price_adjustment'), // minor units
    titleOverride: text('title_override'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    bundleIdIdx: index('bundle_item_bundle_id_idx').on(t.bundleId),
    // The same variant twice in one bundle is a bug, not a use case — the
    // editor already de-dupes by variantId.
    bundleVariantUnq: uniqueIndex('bundle_item_bundle_variant_unq').on(t.bundleId, t.variantId),
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
