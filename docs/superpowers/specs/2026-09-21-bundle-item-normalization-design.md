# Bundle items — normalize `bundle.items` JSON into `bundle_item`

**Date:** 2026-09-21
**Status:** Design — ready for `superpowers:writing-plans`
**Depends on:** E6 (bundles CRUD, cart transform, metafield lifecycle), the repository layer
(`src/db/repositories/`, `BaseRepository` / `ShopScopedRepository`)
**Touches:** D1 schema + migration, repository layer, `src/routes/bundles.ts`,
`src/routes/variants.ts`, `src/lib/bundleMetafields.ts`, `web/types/bundles.ts`,
`web/Pages/BundleEditor.tsx`, `web/Pages/Bundles.tsx`, `docs/erd.dbml`

---

## Summary

`bundle.items` is a JSON text column holding the bundle's components, and
`bundle.sum_of_items` is a separate integer column holding their total. This design splits the
JSON into a `bundle_item` table, makes the total a computed `sum(price * qty)`, and makes the
backend resolve every item's price and name from Shopify on save rather than trusting what the
client sent.

Three things motivate it:

1. **`items` and `sum_of_items` can disagree.** `PUT /api/bundles/:id` patches them as
   independent fields (`src/routes/bundles.ts:373,376`), so a client can change the components
   without changing the total. The stored savings figure then lies, and nothing detects it.
2. **Item prices are client-supplied and unverified.** The editor reads them from the resource
   picker and posts them; the backend stores whatever arrives. For `expand` bundles those prices
   are written into the `composition_v2` metafield the Rust cart-transform function reads at
   checkout.
3. **Money is hardcoded to 2 decimal places and USD.** `toCents` multiplies by 100
   (`bundles.ts:76`) and `money()` prefixes `$` with an `en-US` locale, duplicated in
   `web/Pages/Bundles.tsx:20` and `web/Pages/BundleEditor.tsx:45`. `shopifyShop.currency` is
   captured at install and never used. A ¥1,000 item stores `100000` and renders `¥1,000.00`.

---

## Current state

**Schema** (`src/db/schema.ts`):

```
bundle.items         text NOT NULL   -- JSON [{variantId, qty, price?, priceAdjustment?, titleOverride?}]
bundle.sum_of_items  integer         -- cents
bundle.price         integer         -- cents; the merge parent price
```

**Who reads `items`:**

| Consumer | Uses |
|---|---|
| `toDto` (`bundles.ts:85`) | whole array, parsed to JSON for the API response |
| `compositionFromItems` (`bundleMetafields.ts:59`) | `variantId`, `qty`, `price` → `composition_v2` (**expand**) |
| `mergeConfigEntry` (`bundleMetafields.ts:216`) | `variantId` only, de-duped into `sources` (**merge**) |
| `BundleEditor.tsx:420` | computes the preview sum as `Σ (price × qty)` |

`priceAdjustment` and `titleOverride` are stored but read by nothing — they are collected by the
`update` operation's form and never reach a metafield or the Rust function. They are carried
across unchanged by this design; removing them is a separate decision.

**Variant resolution** already exists. `GET /api/variants` (`src/routes/variants.ts`) resolves a
set of variant GIDs to product/variant titles, an admin deep link and an image in one Admin
`nodes(ids:)` call, and reports `exists: false` for a deleted variant. It does **not** currently
select `price`. Its results are deliberately not persisted, so a rename in Shopify shows up
immediately.

---

## Design

### 1. `bundle_item`

```ts
export const bundleItem = sqliteTable('bundle_item', {
  id: text('id').primaryKey(),
  shopId: text('shop_id').notNull()
    .references(() => shopifyShop.id, { onDelete: 'cascade' }),
  bundleId: text('bundle_id').notNull()
    .references(() => bundle.id, { onDelete: 'cascade' }),

  variantId: text('variant_id').notNull(),   // ProductVariant GID
  // Snapshot of the variant's title at save time. READ ONLY when the variant
  // fails to resolve against Shopify — a live variant's name always comes from
  // the Admin API so renames appear immediately. See "Deleted variants".
  name: text('name').notNull(),
  qty: integer('qty').notNull(),
  price: integer('price').notNull(),         // per-unit, MINOR UNITS

  priceAdjustment: integer('price_adjustment'),  // minor units; `update` only
  titleOverride: text('title_override'),         // `update` only

  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  bundleIdx: index('bundle_item_bundle_id_idx').on(t.bundleId),
  variantUnq: uniqueIndex('bundle_item_bundle_variant_unq').on(t.bundleId, t.variantId),
}));
```

`bundle` drops `items` and `sum_of_items`.

**`shop_id` is deliberately redundant.** It is reachable through `bundleId`, but carrying it is
what lets `BundleItemRepository` extend `ShopScopedRepository` and inherit `where shop_id = ?` on
every read and write. Without the column the child table sits outside the isolation guarantee and
every query would need a hand-written join to stay tenant-safe — the exact failure mode the
constructor-scoped repositories were built to remove.

**There is no `position` column.** The editor has no reorder UI: order is whatever the resource
picker returned, with kept items shuffled ahead of newly picked ones on a partial selection
(`BundleEditor.tsx:359,367`). Storing that would freeze an accident, not merchant intent. Items
are ordered by `name` — deterministic, stable across loads, and alphabetical is a defensible list
order. Nothing downstream depends on a specific order: `compositionFromItems` maps the array as
given, and `mergeConfigEntry`'s `sources` is a matching set. If drag-to-reorder is ever added,
`position` goes in then as a plain integer with **no** unique constraint, so a swap does not
violate uniqueness mid-update.

The `(bundle_id, variant_id)` unique makes the same variant appearing twice in one bundle
unrepresentable. The editor already de-dupes by `variantId` (`BundleEditor.tsx:360`), so a
duplicate is a bug rather than a use case.

### 2. Money

All money in D1 is stored as **integer minor units**. Not "cents": the exponent varies by
currency — JPY and KRW are 0, KWD and BHD are 3, most others 2.

The exponent is derived from `shopifyShop.currency` at the API boundary:

```ts
new Intl.NumberFormat('en', { style: 'currency', currency })
  .resolvedOptions().maximumFractionDigits
```

No lookup table to maintain, and Workers ship full ICU so this works server-side. Shopify returns
`ProductVariant.price` as a decimal **string** (`"29.99"`), so it converts to minor units without
a float being involved.

`toCents` / `toDollars` in `bundles.ts` become exponent-aware and take the shop's currency. The
two hardcoded `money()` helpers collapse into one shared formatter built from
`Intl.NumberFormat(shop.primaryLocale ?? 'en', { style: 'currency', currency: shop.currency })`.

**The database stays currency-blind.** Every item in a bundle belongs to one shop and therefore
one currency, so `sum(price * qty)` is correct without the DB knowing what the currency is.
Currency is applied only when parsing input and formatting output.

### 3. Save flow

```
POST /api/bundles  |  PUT /api/bundles/:id
  │
  ├─ 1. resolveVariants(every item GID)        ONE Admin nodes(ids:) call
  │       ├─ exists → overwrite the client's price and name with Shopify's
  │       └─ gone   → PUT: keep the stored price and name snapshot
  │                   POST: 400 — there is no prior row to fall back on
  │
  ├─ 2. db.batch([ delete bundle_item where bundle_id = ?,
  │                insert each resolved item,
  │                update bundle ])            ← atomic
  │
  └─ 3. write the metafield → metafieldState   ← may fail; the row survives
```

**Prices sent by the client are never trusted.** They exist so the editor can show a live total
while the merchant is picking. Step 1 overwrites them for every operation, not just `expand` —
this keeps `sum_of_items` meaningful for `merge` bundles too, which the Bundles list depends on
for its savings column (`bundles.ts:105`).

**Step 2 is atomic, step 3 is not.** D1 has no interactive transactions, so the multi-statement
item replacement goes through `db.batch()`. The existing two-phase failure model is unchanged: a
failed metafield write returns 502 and leaves the row saved, with `metafieldState` recording that
step 3 did not land. The merchant does not lose their edit.

`resolveVariants` is extracted from `src/routes/variants.ts` into a shared lib with `price` added
to the selection set, so the GET endpoint and the save path use one implementation.

### 4. Deleted variants

An **edit** is never rejected because a variant was deleted. Rejecting would trap the merchant:
the only way to fix the bundle is to edit it, and editing is what would be blocked. The item keeps
the `price` and `name` already on its row.

A **create** is different — there is no existing row to carry forward, so `price NOT NULL` cannot
be satisfied. The resource picker cannot offer a deleted variant, so this only arises from a
direct API call, and it returns 400 naming the variant.

Instead `GET /api/bundles/:id` returns each item with its stored `name` and `price`. The editor
already calls `/api/variants` on load, which reports `exists: false`, and renders a banner:

> **Blue T-Shirt / Large — A$29.99** was deleted in Shopify.
> `[Remove from bundle]`

The button removes the item from local state; the merchant then saves normally. The `name`
snapshot exists purely so this message can name the variant — Shopify returns nothing for a
deleted one, so without it the banner could only say `Variant #4837261`.

### 5. Repository

`BundleItemRepository extends ShopScopedRepository<typeof bundleItem>`:

| Method | Purpose |
|---|---|
| `listForBundle(bundleId)` | items ordered by `name` |
| `replaceForBundle(bundleId, items)` | the delete-all + insert-all batch |
| `sumFor(bundleId)` | `sum(price * qty)` for one bundle |
| `sumsByBundle()` | one grouped query for the whole shop |

`sumsByBundle()` matters: `GET /api/bundles` renders a savings column for every row, and a
per-bundle sum would be N+1 across the list.

Registered in `src/db/repositories/index.ts` (`Repositories` + `createRepositoriesFromDb`), with
an `InMemoryBundleItemRepository` in `inMemory.ts`.

### 6. DTO

Money fields become Shopify's MoneyV2 shape, so the frontend formats from what it is given and no
component can quietly default to `$`:

```json
{
  "price":      { "amount": "29.99", "currencyCode": "AUD" },
  "sumOfItems": { "amount": "39.99", "currencyCode": "AUD" },
  "items": [
    { "variantId": "gid://shopify/ProductVariant/1",
      "name": "Blue T-Shirt / Large",
      "qty": 2,
      "price": { "amount": "15.00", "currencyCode": "AUD" } }
  ]
}
```

`sumOfItems` is computed and therefore **read-only** — `POST`/`PUT` reject it in the request body
rather than ignoring it, so a client sending a stale total gets told rather than silently
overruled. The editor currently does send it (`BundleEditor.tsx:455`) and must stop; it keeps
computing the same figure locally for the live preview, but no longer posts it.

### 7. Migration

Existing bundle data is disposable (dev store only), so this is a single migration:

1. create `bundle_item`
2. recreate `bundle` without `items` and `sum_of_items` (SQLite requires table recreation to drop
   a column; drizzle-kit generates this)

**No item data is carried over.** Legacy `items` JSON has no `name` field at all, and
`bundle_item.name` is `NOT NULL`, so there is nothing valid to insert — and SQL cannot call the
Admin API to fetch one. Fabricating a name, or defaulting it to the variant id, would put a
placeholder into the column the deleted-variant banner reads, which is precisely the case where a
wrong label is worse than an obvious absence.

Bundles keep their name, price, status and metafield state; they simply have no components until
the merchant re-picks them. For an `expand` bundle that is a state the routes already reject on
save, so it surfaces in the editor as a bundle that cannot be saved until its items are re-picked.
This is intended: the alternative is a bundle that looks fine and writes an empty
`composition_v2`, which aborts the entire cart-transform invocation for that cart.

Because nothing is converted, the migration needs no currency lookup.

`docs/erd.dbml` is updated in the same change as the schema and the migration, per the root
`CLAUDE.md` rule.

---

## Testing

- **Repository** — `BundleItemRepository` against the recording fake D1
  (`src/db/repositories/testing/fakeD1.ts`), asserting the emitted SQL carries
  `where shop_id = ?` on every read and write, including `replaceForBundle`'s batch and the
  grouped `sumsByBundle`.
- **Money** — the exponent helper across JPY (0), AUD (2) and KWD (3); a round trip
  `"29.99" → 2999 → "29.99"` for each.
- **Save flow** — route tests against the in-memory repositories: a client-sent price is
  overwritten by the resolved one; a deleted variant keeps its stored price and name and does not
  fail the save; `sumOfItems` in the response equals `Σ (price × qty)`; a body containing
  `sumOfItems` is rejected.
- **Atomicity** — a failing insert inside `replaceForBundle` leaves the previous items intact.
- **Metafield** — `compositionFromItems` still produces the same `composition_v2` entries for an
  expand bundle built from rows rather than JSON.

---

## Out of scope

- Removing `priceAdjustment` / `titleOverride`, which are stored but read by nothing.
- Drag-to-reorder, and the `position` column it would need.
- Backfilling prices for legacy rows — the data is disposable.
- Any change to the Rust cart-transform function. `composition_v2` and `merge_bundles` keep their
  current shape; only how the app assembles them changes.
