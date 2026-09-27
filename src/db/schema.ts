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

    // Normalized UTC ISO-8601 (`2026-10-03T09:00:00.000Z`) or null for "no
    // bound". Fixed width and Z-suffixed on purpose: that is what makes the
    // plain string comparisons in the due-scan below chronological.
    scheduleStart: text('schedule_start'),
    scheduleEnd: text('schedule_end'),

    // `status` is DERIVED from the window (see src/lib/scheduleWindow.ts) and
    // then persisted. The stored value is the record of what has actually been
    // written to Shopify; the derived value is what should be true now. The
    // gap between the two is exactly the scheduling cron's work queue.
    // `Draft` is outside the derivation — it is the merchant's manual
    // off-switch and is never scheduled over.
    status: text('status', { enum: ['Active', 'Scheduled', 'Ended', 'Draft'] }).notNull(),

    // Last failed schedule transition, cleared on success. Without it a failed
    // boundary is invisible: the bundle simply never goes live and the merchant
    // has no way to know why.
    scheduleError: text('schedule_error'),
    blockOnFailure: integer('block_on_failure').notNull().default(0),

    // Set at publish when a campaign takes over this bundle's schedule.
    // `set null`, NOT cascade: deleting a campaign must free its bundles, not
    // delete them — the bundle is the merchant's, the schedule was the
    // campaign's. The LOCK is derived from the owning campaign's status rather
    // than from this column being set (see src/lib/campaignStatus.ts), so an
    // ended campaign's bundles unlock with nothing having to clear this.
    campaignId: text('campaign_id').references(() => campaign.id, { onDelete: 'set null' }),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    shopIdIdx: index('bundle_shop_id_idx').on(t.shopId),
    // The scheduling cron's two due-scans. Deliberately NOT shop_id-leading:
    // the scan is cross-shop by design (see DueBundleScanner), and a
    // shop-leading index would not serve it.
    dueStartIdx: index('bundle_due_start_idx').on(t.status, t.scheduleStart),
    dueEndIdx: index('bundle_due_end_idx').on(t.status, t.scheduleEnd),
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

// ─── template ───────────────────────────────────────────────────────────────
//
// Promotion templates (E5): curated editorial content — copy, examples, and the
// defaults a create form is prefilled with.
//
// DELIBERATELY GLOBAL: no `shopId`, no FK to `shopify_shop`, and so the second
// documented exception to this project's tenant rule after `webhook_event`.
// The justification is a property of the data, not convenience: these rows are
// identical for every shop, carry no merchant data, and have nothing to cascade
// on SHOP_REDACT. Giving them a `shopId` would mean N identical copies and a
// scoped repository asserting an isolation guarantee that protects nothing.
//
// `slug` is the route key (`/templates/:slug`); `id` stays a minted UUID so the
// project's id rule holds.
export const template = sqliteTable(
  'template',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),

    name: text('name').notNull(),
    description: text('description').notNull(),
    example: text('example'),
    category: text('category').notNull(),
    symbol: text('symbol'),

    // The engine this template targets. Merchant-facing surfaces show
    // `category`; this is never displayed.
    type: text('type', { enum: ['tier', 'bundle', 'special'] }).notNull(),

    // JSON: the partial form data the create page is seeded with.
    defaults: text('defaults').notNull(),

    sortOrder: integer('sort_order').notNull().default(0),
    // 0/1 — SQLite has no boolean. Retire a template without deleting it.
    active: integer('active').notNull().default(1),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    slugUnq: uniqueIndex('template_slug_unq').on(t.slug),
    activeSortIdx: index('template_active_sort_idx').on(t.active, t.sortOrder),
  }),
);

// ─── campaign ───────────────────────────────────────────────────────────────
//
// A campaign groups discounts and bundles onto ONE window. It has no runtime
// behaviour of its own: publishing stamps that window onto its members, and
// each member is then scheduled by the mechanism it already had — Shopify for
// discounts, our cron for bundles. Both carry the same two timestamps, so they
// fire together by construction rather than by coordination.
//
// `status` is `Draft` until published and DERIVED from the window afterwards
// (see src/lib/campaignStatus.ts). The stored value is a cache of that
// derivation, refreshed on read — never an independent source of truth.
export const campaign = sqliteTable(
  'campaign',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id').notNull().references(() => shopifyShop.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['Draft', 'Scheduled', 'Published', 'Ended'] }).notNull(),

    scheduleMode: text('schedule_mode', { enum: ['immediate', 'window'] }).notNull(),
    // Normalized UTC ISO-8601, like every other schedule column in this schema.
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),

    publishedAt: text('published_at'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    shopStatusIdx: index('campaign_shop_status_idx').on(t.shopId, t.status),
  }),
);

// ─── campaign_discount ──────────────────────────────────────────────────────
//
// A discount the campaign authors: its config before publish, its Shopify
// identity after. `type` uses the lowercase engine names so it matches
// `DiscountEngineType` and `discount.type` — one vocabulary, not two.
export const campaignDiscount = sqliteTable(
  'campaign_discount',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id').notNull().references(() => shopifyShop.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').notNull().references(() => campaign.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    type: text('type', { enum: ['tier', 'bundle', 'special'] }).notNull(),
    method: text('method', { enum: ['automatic', 'code'] }).notNull(),
    // Required when `method` is 'code'; it becomes the discount's title.
    code: text('code'),

    // The merchant's FORM state for this discount — NOT the serialized
    // `$app:` metafield value. Publish creates the discount through the same
    // path `POST /api/discounts` uses (adapter lookup -> validate ->
    // serialize -> size check), and that path's INPUT is a form; `serialize`
    // is what produces the metafield value from it. A pre-serialized config
    // could be neither re-validated nor rendered back into form fields to
    // edit a draft, so the form is what this column holds.
    configJson: text('config_json').notNull(),
    // Size in bytes of the SERIALIZED config — i.e. what
    // `getAdapter(type).sizeBytes(form)` returns for `configJson` above — not
    // the byte length of `configJson` itself. 10 KB is Shopify's cap on the
    // metafield value, so the meter has to measure that value, not the form.
    // Nothing writes this column yet; it is only defined here.
    configBytes: integer('config_bytes').notNull(),

    shopifyGid: text('shopify_gid'),
    publishState: text('publish_state', { enum: ['pending', 'created', 'failed'] }).notNull(),
    publishError: text('publish_error'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    campaignIdx: index('campaign_discount_campaign_idx').on(t.campaignId),
  }),
);

// ─── campaign_bundle ────────────────────────────────────────────────────────
//
// A reference to an existing E6 bundle. No config is authored here — the bundle
// owns its own definition; the campaign only owns its SCHEDULE while live.
export const campaignBundle = sqliteTable(
  'campaign_bundle',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id').notNull().references(() => shopifyShop.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').notNull().references(() => campaign.id, { onDelete: 'cascade' }),
    bundleId: text('bundle_id').notNull().references(() => bundle.id, { onDelete: 'cascade' }),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    // The same bundle twice in one campaign is a bug, not a use case.
    campaignBundleUnq: uniqueIndex('campaign_bundle_unq').on(t.campaignId, t.bundleId),
  }),
);
