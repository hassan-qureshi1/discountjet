# Bundle Item Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `bundle.items` JSON into a `bundle_item` table, make `sumOfItems` a computed `sum(price * qty)`, and have the backend resolve every item's price and name from Shopify on save instead of trusting the client.

**Architecture:** A new `bundle_item` table extends `ShopScopedRepository`, so `where shop_id = ?` is welded onto every query. Money is stored as integer minor units and converted at the API boundary using an exponent derived from the shop's currency via `Intl`. On save, one Admin `nodes(ids:)` call re-resolves every item's price and name; the item replacement runs in a `db.batch()` so it is atomic, then the metafield write happens as a separate phase that may fail without losing the row.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Drizzle ORM, Vitest, React 18 + Shopify Polaris.

**Spec:** `docs/superpowers/specs/2026-09-21-bundle-item-normalization-design.md`

## Global Constraints

- All IDs are `crypto.randomUUID()`; timestamps are ISO 8601 strings in `text()` columns.
- Every shop-owned table carries a non-null `shopId` FK to `shopify_shop` with `onDelete: 'cascade'`, and its repository extends `ShopScopedRepository`.
- All D1 access goes through `src/db/repositories/`. No `createDb()` and no `drizzle-orm` import outside that directory.
- Never mask a missing field with `?? ''` or a default — fail loudly.
- Money in D1 is **integer minor units**. Never "cents": JPY is exponent 0, KWD is 3.
- `docs/erd.dbml` is updated in the same change as any `schema.ts` edit.
- Repository tests use the recording fake D1 (`src/db/repositories/testing/fakeD1.ts`); route tests use the in-memory fakes (`src/db/repositories/inMemory.ts`). Never mock the Drizzle query builder.
- Run `npx vitest run` and `npx tsc --noEmit` before every commit.

---

### Task 1: Money helper (minor units + currency exponent)

**Files:**
- Create: `src/lib/money.ts`
- Test: `src/lib/money.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface MoneyV2 { amount: string; currencyCode: string }`, `currencyExponent(currencyCode: string): number`, `toMinorUnits(amount: string | number, currencyCode: string): number`, `toMoney(minorUnits: number | null, currencyCode: string): MoneyV2 | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { currencyExponent, toMinorUnits, toMoney } from './money';

describe('currencyExponent', () => {
  it('reads the exponent from Intl rather than assuming 2', () => {
    expect(currencyExponent('AUD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('throws on an unknown currency instead of defaulting', () => {
    expect(() => currencyExponent('NOPE')).toThrow(/NOPE/);
  });
});

describe('toMinorUnits', () => {
  it('converts a decimal string without touching a float', () => {
    expect(toMinorUnits('29.99', 'AUD')).toBe(2999);
    expect(toMinorUnits('1000', 'JPY')).toBe(1000);
    expect(toMinorUnits('1.234', 'KWD')).toBe(1234);
  });

  it('pads a short fraction', () => {
    expect(toMinorUnits('5.1', 'AUD')).toBe(510);
    expect(toMinorUnits('7', 'AUD')).toBe(700);
  });

  it('rounds a fraction longer than the currency allows', () => {
    expect(toMinorUnits('1.005', 'AUD')).toBe(101);
    expect(toMinorUnits('1.004', 'AUD')).toBe(100);
  });

  it('rejects a non-numeric amount rather than coercing it', () => {
    expect(() => toMinorUnits('abc', 'AUD')).toThrow(/abc/);
  });
});

describe('toMoney', () => {
  it('round-trips minor units back to a decimal string', () => {
    expect(toMoney(2999, 'AUD')).toEqual({ amount: '29.99', currencyCode: 'AUD' });
    expect(toMoney(1000, 'JPY')).toEqual({ amount: '1000', currencyCode: 'JPY' });
    expect(toMoney(1234, 'KWD')).toEqual({ amount: '1.234', currencyCode: 'KWD' });
  });

  it('pads the fraction back out', () => {
    expect(toMoney(510, 'AUD')).toEqual({ amount: '5.10', currencyCode: 'AUD' });
    expect(toMoney(5, 'AUD')).toEqual({ amount: '0.05', currencyCode: 'AUD' });
  });

  it('passes null through — an absent amount is not zero', () => {
    expect(toMoney(null, 'AUD')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/money.test.ts`
Expected: FAIL — `Failed to resolve import "./money"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/money.ts`:

```ts
/**
 * Money helpers. All money in D1 is stored as integer MINOR UNITS — deliberately
 * not called "cents", because the number of minor units in a major unit depends
 * on the currency: JPY and KRW have 0, most currencies 2, KWD and BHD have 3.
 *
 * The exponent comes from Intl rather than a hand-maintained table. Workers ship
 * full ICU, so this resolves server-side exactly as it does in the browser.
 */

/** Shopify's MoneyV2 shape — an exact decimal string plus its currency. */
export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

/** Minor units per major unit, as a power of ten. AUD -> 2, JPY -> 0, KWD -> 3. */
export function currencyExponent(currencyCode: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode })
      .resolvedOptions().maximumFractionDigits;
  } catch {
    // A shop row with a bad or missing currency is a data-integrity problem.
    // Defaulting to 2 would silently store JPY off by a factor of 100.
    throw new Error(`[money] unknown currency code: ${currencyCode}`);
  }
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d*))?$/;

/**
 * Decimal amount -> integer minor units, by string manipulation rather than
 * multiplication. `29.99 * 100` is 2998.9999999999995 in IEEE 754; this is not.
 */
export function toMinorUnits(amount: string | number, currencyCode: string): number {
  const exponent = currencyExponent(currencyCode);
  const text = typeof amount === 'number' ? amount.toFixed(exponent) : amount.trim();

  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`[money] not a decimal amount: ${amount}`);

  const [, sign, whole, fraction = ''] = match;

  // Keep `exponent` fraction digits, rounding on the first discarded one.
  const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
  const roundUp = (fraction[exponent] ?? '0') >= '5';

  const magnitude = Number(`${whole}${kept}`) + (roundUp ? 1 : 0);
  return sign === '-' ? -magnitude : magnitude;
}

/** Integer minor units -> MoneyV2. Null passes through: absent is not zero. */
export function toMoney(minorUnits: number | null, currencyCode: string): MoneyV2 | null {
  if (minorUnits === null) return null;

  const exponent = currencyExponent(currencyCode);
  const negative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits)).padStart(exponent + 1, '0');

  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;

  return { amount: `${negative ? '-' : ''}${whole}${fraction}`, currencyCode };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/money.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts
git commit -m "feat(money): currency-aware minor-unit conversion

Reads the exponent from Intl instead of assuming two decimal places, so
JPY (0) and KWD (3) stop being stored and rendered off by a factor of a
hundred. Conversion is string-based: 29.99 * 100 is 2998.9999999999995 in
IEEE 754, which is exactly the drift this replaces."
```

---

### Task 2: Shared variant resolver with price

**Files:**
- Create: `src/lib/variantResolver.ts`
- Create: `src/lib/variantResolver.test.ts`
- Modify: `src/routes/variants.ts` (replace its inline query and mapping with the shared resolver)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `interface ResolvedVariant { id; exists; productId?; productTitle?; variantTitle?; adminUrl?; imageUrl?; imageAlt?; price?: string }`, `resolveVariants(shopDomain: string, env: Env, ids: string[]): Promise<Map<string, ResolvedVariant>>`, `variantDisplayName(v: ResolvedVariant): string | undefined`, `VARIANT_GID: RegExp`, `MAX_VARIANT_IDS: number`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/variantResolver.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { resolveVariants, variantDisplayName } from './variantResolver';
import type { Env } from '../types/env';

const env = {} as Env;
const SHOP = 'test-shop.myshopify.com';
const GID = 'gid://shopify/ProductVariant/1';

beforeEach(() => vi.clearAllMocks());

describe('resolveVariants', () => {
  it('returns price alongside the titles', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { nodes: [{
        id: GID, title: 'Large', price: '29.99', image: null,
        product: { id: 'gid://shopify/Product/9', title: 'Blue T-Shirt', featuredImage: null },
      }] },
    } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    expect(resolved.get(GID)).toMatchObject({
      id: GID, exists: true, price: '29.99',
      productTitle: 'Blue T-Shirt', variantTitle: 'Large',
    });
  });

  it('marks a deleted variant as absent rather than omitting it', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [null] } } as never);

    const resolved = await resolveVariants(SHOP, env, [GID]);

    expect(resolved.get(GID)).toEqual({ id: GID, exists: false });
  });

  it('de-duplicates ids so a repeated variant costs one node', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [] } } as never);

    await resolveVariants(SHOP, env, [GID, GID]);

    expect(vi.mocked(adminGraphql).mock.calls[0][3]).toEqual({ ids: [GID] });
  });

  it('throws on GraphQL errors instead of returning a half-empty map', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ errors: [{ message: 'boom' }] } as never);

    await expect(resolveVariants(SHOP, env, [GID])).rejects.toThrow(/boom/);
  });

  it('resolves nothing without calling Shopify when given no ids', async () => {
    const resolved = await resolveVariants(SHOP, env, []);

    expect(resolved.size).toBe(0);
    expect(adminGraphql).not.toHaveBeenCalled();
  });
});

describe('variantDisplayName', () => {
  it('joins product and variant titles', () => {
    expect(variantDisplayName({
      id: GID, exists: true, productTitle: 'Blue T-Shirt', variantTitle: 'Large',
    })).toBe('Blue T-Shirt / Large');
  });

  it('is undefined for a variant that did not resolve', () => {
    expect(variantDisplayName({ id: GID, exists: false })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/variantResolver.test.ts`
Expected: FAIL — `Failed to resolve import "./variantResolver"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/variantResolver.ts`:

```ts
import type { Env } from '../types/env';
import { adminGraphql } from './graphqlAdmin';

/** Shopify's `nodes` query accepts at most 250 ids; a bundle never needs more
 * than a handful, so this cap bounds a malformed request, not the API limit. */
export const MAX_VARIANT_IDS = 50;

export const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** `gid://shopify/ProductVariant/123` -> `123`. */
export function numericId(gid: string): string {
  const match = gid.match(/(\d+)$/);
  if (!match) throw new Error(`[variantResolver] unexpected gid shape: ${gid}`);
  return match[1];
}

interface ImageNode { url: string; altText: string | null }

interface VariantNode {
  id: string;
  title: string;
  price: string;
  image: ImageNode | null;
  product: { id: string; title: string; featuredImage: ImageNode | null } | null;
}

interface NodesResponse { nodes: (VariantNode | null)[] }

const VARIANT_NODES_QUERY = `
  query BundleVariantNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
        image { url altText }
        product { id title featuredImage { url altText } }
      }
    }
  }
`;

export interface ResolvedVariant {
  id: string;
  exists: boolean;
  /** Owning product gid — the resource picker pre-selects by product. */
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  adminUrl?: string;
  imageUrl?: string;
  imageAlt?: string;
  /** Per-unit price as an exact decimal string in the shop's currency. */
  price?: string;
}

/** `Blue T-Shirt / Large`, or undefined when the variant no longer resolves. */
export function variantDisplayName(v: ResolvedVariant): string | undefined {
  if (!v.exists) return undefined;
  return [v.productTitle, v.variantTitle].filter(Boolean).join(' / ') || undefined;
}

/**
 * Resolves variant gids to titles, price, an image and an admin deep link in ONE
 * Admin call. Shared by `GET /api/variants` (so the editor can render names) and
 * by the bundle save path (so item prices come from Shopify, not the client).
 *
 * Returns one entry per requested id — `exists: false` for a deleted variant —
 * so a caller can always index the map rather than checking for a miss.
 */
export async function resolveVariants(
  shopDomain: string,
  env: Env,
  ids: string[],
): Promise<Map<string, ResolvedVariant>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const result = await adminGraphql<NodesResponse>(shopDomain, env, VARIANT_NODES_QUERY, {
    ids: unique,
  });

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Failed to resolve variants: ${JSON.stringify(result.errors)}`);
  }

  const byId = new Map<string, VariantNode>();
  for (const node of result.data?.nodes ?? []) {
    if (node?.id) byId.set(node.id, node);
  }

  const resolved = new Map<string, ResolvedVariant>();
  for (const id of unique) {
    const node = byId.get(id);
    // A variant whose product is missing can't be linked into the admin, so it
    // is reported the same as a deleted one rather than half-rendered.
    if (!node || !node.product) {
      resolved.set(id, { id, exists: false });
      continue;
    }

    const image = node.image ?? node.product.featuredImage;
    resolved.set(id, {
      id,
      exists: true,
      productId: node.product.id,
      productTitle: node.product.title,
      variantTitle: node.title,
      price: node.price,
      adminUrl: `https://${shopDomain}/admin/products/${numericId(node.product.id)}/variants/${numericId(id)}`,
      ...(image ? { imageUrl: image.url } : {}),
      ...(image?.altText ? { imageAlt: image.altText } : {}),
    });
  }

  return resolved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/variantResolver.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Point the variants route at the shared resolver**

Replace the body of `src/routes/variants.ts` below the imports. Delete its local `VARIANT_GID`, `numericId`, `ImageNode`, `VariantNode`, `NodesResponse`, `VARIANT_NODES_QUERY`, `ResolvedVariant` and `MAX_IDS`, and re-export the type so existing importers keep working:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import { requireShopDomain } from '../lib/shopDomain';
import {
  MAX_VARIANT_IDS,
  VARIANT_GID,
  resolveVariants,
  type ResolvedVariant,
} from '../lib/variantResolver';

export type { ResolvedVariant };

export const variantRoutes = new Hono<AppEnv>();

// GET /api/variants?ids=<gid>,<gid> — resolves product + variant titles, price
// and a variant-level admin deep link for a set of variant gids, in ONE Admin
// call.
//
// Deliberately not persisted: the editor resolves names at page load so a
// merchant renaming a product in Shopify is reflected immediately, and so the
// app never holds a stale copy of catalogue data it doesn't own. The one
// exception is `bundle_item.name`, which is read only when a variant no longer
// resolves — see the column comment in `src/db/schema.ts`.
variantRoutes.get('/api/variants', async (c) => {
  const raw = c.req.query('ids');
  if (!raw || raw.trim() === '') {
    return c.json({ error: 'Query parameter `ids` is required.' }, 400);
  }

  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id !== ''))];

  if (ids.length === 0) {
    return c.json({ error: 'Query parameter `ids` is required.' }, 400);
  }
  if (ids.length > MAX_VARIANT_IDS) {
    return c.json({ error: `Too many ids: ${ids.length} requested, max ${MAX_VARIANT_IDS}.` }, 400);
  }

  const invalid = ids.filter((id) => !VARIANT_GID.test(id));
  if (invalid.length > 0) {
    return c.json({ error: `Not ProductVariant ids: ${invalid.join(', ')}` }, 400);
  }

  const shopDomain = requireShopDomain(c);

  let resolved;
  try {
    resolved = await resolveVariants(shopDomain, c.env, ids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }

  return c.json({ variants: ids.map((id) => resolved.get(id) ?? { id, exists: false }) });
});
```

- [ ] **Step 6: Verify nothing regressed**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/variantResolver.ts src/lib/variantResolver.test.ts src/routes/variants.ts
git commit -m "refactor(variants): extract a shared resolver and select price

The bundle save path needs to re-resolve item prices from Shopify rather
than trusting the client, and it needs the same nodes(ids:) call the
variants endpoint already makes. Extracting it means one implementation
and one place where 'deleted variant' is defined, instead of the route
and the save path drifting apart."
```

---

### Task 3: Schema, migration and ERD

**Files:**
- Modify: `src/db/schema.ts` (add `bundleItem`; drop `items` and `sumOfItems` from `bundle`)
- Create: `drizzle/migrations/<generated>.sql`
- Modify: `docs/erd.dbml`

**Interfaces:**
- Consumes: nothing.
- Produces: the `bundleItem` Drizzle table. `typeof bundleItem.$inferSelect` has `id, shopId, bundleId, variantId, name, qty, price, priceAdjustment, titleOverride, createdAt, updatedAt`.

- [ ] **Step 1: Add the table to the schema**

In `src/db/schema.ts`, replace the `items` and `sumOfItems` lines in `bundle`:

```ts
    name: text('name').notNull(),
    operation: text('operation', { enum: ['merge', 'expand', 'update'] }).notNull(),

    parentVariantId: text('parent_variant_id'),
    price: integer('price'), // minor units
```

(The `items: text('items').notNull(),` and `sumOfItems: integer('sum_of_items'),` lines are deleted, and the `// cents` comment on `price` becomes `// minor units`.)

Then append after the `bundle` table:

```ts
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
```

- [ ] **Step 2: Generate the migration**

Run: `npm run d1:generate`
Expected: a new file in `drizzle/migrations/` containing `CREATE TABLE bundle_item`, its two indexes, and a `bundle` table recreation (SQLite cannot drop a column in place).

- [ ] **Step 3: Confirm the migration carries no item data**

Open the generated SQL and verify it does **not** attempt to populate `bundle_item`. It should not. Add this comment at the top of the file:

```sql
-- No item data is migrated. Legacy `bundle.items` JSON has no `name` field and
-- `bundle_item.name` is NOT NULL, so there is nothing valid to insert, and SQL
-- cannot call the Admin API to fetch one. Existing bundles keep their name,
-- price, status and metafield state, and have no components until the merchant
-- re-picks them. See docs/superpowers/specs/2026-09-21-bundle-item-normalization-design.md §7.
```

- [ ] **Step 4: Apply the migration locally**

Run: `npm run d1:migrate:local`
Expected: applies cleanly, no errors.

- [ ] **Step 5: Update the ERD**

In `docs/erd.dbml`, delete the `items` and `sum_of_items` lines from `Table bundle`, change `price`'s note to `minor units`, and add:

```
Table bundle_item {
  id text [pk]
  shop_id text [not null, ref: > shopify_shop.id, note: 'ON DELETE CASCADE — redundant via bundle_id, carried so the repository can be shop-scoped']
  bundle_id text [not null, ref: > bundle.id, note: 'ON DELETE CASCADE']

  variant_id text [not null, note: 'ProductVariant GID']
  name text [not null, note: 'title snapshot — READ ONLY when the variant fails to resolve']
  qty integer [not null]
  price integer [not null, note: 'per-unit, minor units']

  price_adjustment integer [note: 'minor units; update operation only']
  title_override text [note: 'update operation only']

  created_at text [not null]
  updated_at text [not null]

  indexes {
    bundle_id [name: 'bundle_item_bundle_id_idx']
    (bundle_id, variant_id) [unique, name: 'bundle_item_bundle_variant_unq']
  }

  Note: 'Bundle components. The bundle total is not stored — it is sum(price * qty) over these rows, so it cannot disagree with them. No position column: the editor has no reorder UI, so items are ordered by name.'
}
```

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/migrations docs/erd.dbml
git commit -m "feat(db): add bundle_item, drop bundle.items and sum_of_items

items and sum_of_items were patched as independent fields, so the stored
total could disagree with the components it claimed to total. The total is
now sum(price * qty) over bundle_item rows and cannot drift.

No item data migrates: legacy items JSON has no name field, name is NOT
NULL, and SQL cannot call the Admin API for one. Existing bundles keep
their settings and have no components until re-picked."
```

---

### Task 4: BundleItemRepository

**Files:**
- Create: `src/db/repositories/BundleItemRepository.ts`
- Modify: `src/db/repositories/index.ts`
- Modify: `src/db/repositories/inMemory.ts`
- Modify: `src/db/repositories/BundleRepository.ts` (drop nothing; unchanged — listed only so the implementer does not look for changes there)
- Test: `src/db/repositories/BundleItemRepository.test.ts`

**Interfaces:**
- Consumes: `ShopScopedRepository`, `Db` from `./BaseRepository`, `IShopScopedRepository` from `./types`.
- Produces:
  - `type BundleItemRow = typeof bundleItem.$inferSelect`
  - `type BundleItemNew = Omit<typeof bundleItem.$inferInsert, 'shopId'>`
  - `interface IBundleItemRepository extends IShopScopedRepository<BundleItemRow, BundleItemNew> { listForBundle(bundleId: string): Promise<BundleItemRow[]>; replaceForBundle(bundleId: string, items: Array<Omit<BundleItemNew, 'id' | 'bundleId' | 'createdAt' | 'updatedAt'>>): Promise<BundleItemRow[]>; sumFor(bundleId: string): Promise<number | null>; sumsByBundle(): Promise<Map<string, number>> }`
  - `class BundleItemRepository`
  - `Repositories.bundleItems: IBundleItemRepository`
  - `class InMemoryBundleItemRepository`

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/BundleItemRepository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { BundleItemRepository } from './BundleItemRepository';
import { createFakeD1 } from './testing/fakeD1';

const SHOP = 'shop-a';
const OTHER = 'shop-b';

function repo(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  return { fake, items: new BundleItemRepository(createDb(fake.db), SHOP) };
}

describe('BundleItemRepository', () => {
  it('scopes listForBundle by shop as well as bundle, ordered by name', async () => {
    const { fake, items } = repo();
    await items.listForBundle('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"bundle_id" = \?/i);
    expect(sql).toMatch(/order by .*"name"/i);
    expect(params).toEqual(expect.arrayContaining([SHOP, 'b1']));
  });

  it('scopes the sum and multiplies price by qty', async () => {
    const { fake, items } = repo([{ total: 3999 }]);
    await items.sumFor('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/sum\("bundle_item"\."price" \* "bundle_item"\."qty"\)/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toEqual(expect.arrayContaining([SHOP, 'b1']));
  });

  it('groups sumsByBundle so the list page is not N+1', async () => {
    const { fake, items } = repo([{ bundleId: 'b1', total: 3999 }]);
    const sums = await items.sumsByBundle();

    expect(fake.lastQuery().sql).toMatch(/group by "bundle_item"\."bundle_id"/i);
    expect(sums.get('b1')).toBe(3999);
  });

  it('injects the shop on insert regardless of what the caller passed', async () => {
    const { fake, items } = repo([{ id: 'i1' }]);
    await items.create({
      bundleId: 'b1', variantId: 'gid://shopify/ProductVariant/1',
      name: 'Blue T-Shirt / Large', qty: 2, price: 1500,
      createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
      ...({ shopId: OTHER } as unknown as Record<string, never>),
    });

    const { params } = fake.lastQuery();
    expect(params).toContain(SHOP);
    expect(params).not.toContain(OTHER);
  });

  it('replaceForBundle deletes the old rows and inserts the new ones', async () => {
    const { fake, items } = repo([]);
    await items.replaceForBundle('b1', [
      { variantId: 'gid://shopify/ProductVariant/1', name: 'A', qty: 1, price: 100 },
      { variantId: 'gid://shopify/ProductVariant/2', name: 'B', qty: 2, price: 200 },
    ]);

    const kinds = fake.queries.map((q) => q.sql.trim().split(/\s+/)[0].toLowerCase());
    expect(kinds[0]).toBe('delete');
    expect(kinds.filter((k) => k === 'insert')).toHaveLength(2);
    // Every statement is shop-scoped or carries the shop as a bound value.
    for (const q of fake.queries) expect(q.params).toContain(SHOP);
  });

  it('replaceForBundle with no items still clears the old ones', async () => {
    const { fake, items } = repo([]);
    await items.replaceForBundle('b1', []);

    expect(fake.queries).toHaveLength(1);
    expect(fake.lastQuery().sql).toMatch(/^delete/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/db/repositories/BundleItemRepository.test.ts`
Expected: FAIL — `Failed to resolve import "./BundleItemRepository"`.

- [ ] **Step 3: Write the repository**

Create `src/db/repositories/BundleItemRepository.ts`:

```ts
import { asc, eq, sql } from 'drizzle-orm';
import { bundleItem } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type BundleItemRow = typeof bundleItem.$inferSelect;
/** The write shape minus `shopId` — the repository supplies the tenant. */
export type BundleItemNew = Omit<typeof bundleItem.$inferInsert, 'shopId'>;

/** What a caller hands `replaceForBundle`: the repository mints the rest. */
export type BundleItemDraft = Omit<
  BundleItemNew,
  'id' | 'bundleId' | 'createdAt' | 'updatedAt'
>;

export interface IBundleItemRepository
  extends IShopScopedRepository<BundleItemRow, BundleItemNew> {
  listForBundle(bundleId: string): Promise<BundleItemRow[]>;
  replaceForBundle(bundleId: string, items: BundleItemDraft[]): Promise<BundleItemRow[]>;
  sumFor(bundleId: string): Promise<number | null>;
  sumsByBundle(): Promise<Map<string, number>>;
}

/**
 * Bundle components. The bundle's total is never stored — `sumFor` computes it
 * — so it cannot disagree with the rows it totals.
 */
export class BundleItemRepository
  extends ShopScopedRepository<typeof bundleItem>
  implements IBundleItemRepository
{
  constructor(db: Db, shopId: string) {
    super(db, bundleItem, shopId);
  }

  /** Ordered by name: there is no `position`, see the schema comment. */
  async listForBundle(bundleId: string): Promise<BundleItemRow[]> {
    return this.db
      .select()
      .from(bundleItem)
      .where(this.scope(eq(bundleItem.bundleId, bundleId)))
      .orderBy(asc(bundleItem.name))
      .all();
  }

  /**
   * Swaps a bundle's whole component set in ONE `db.batch()`.
   *
   * D1 has no interactive transactions, so a delete-then-insert issued as
   * separate statements can leave a bundle with no components if the insert
   * fails. A batch is applied atomically, which is the only reason this is a
   * repository method rather than a loop in the route.
   */
  async replaceForBundle(bundleId: string, items: BundleItemDraft[]): Promise<BundleItemRow[]> {
    const now = new Date().toISOString();
    const rows: BundleItemRow[] = items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      shopId: this.shopId,
      bundleId,
      priceAdjustment: item.priceAdjustment ?? null,
      titleOverride: item.titleOverride ?? null,
      createdAt: now,
      updatedAt: now,
    }));

    const clear = this.db
      .delete(bundleItem)
      .where(this.scope(eq(bundleItem.bundleId, bundleId)));

    if (rows.length === 0) {
      await clear;
      return [];
    }

    await this.db.batch([
      clear,
      ...rows.map((row) => this.db.insert(bundleItem).values(row)),
    ] as unknown as Parameters<typeof this.db.batch>[0]);

    return rows;
  }

  /** `sum(price * qty)` for one bundle, in minor units. Null when it has no items. */
  async sumFor(bundleId: string): Promise<number | null> {
    const row = await this.db
      .select({ total: sql<number | null>`sum(${bundleItem.price} * ${bundleItem.qty})` })
      .from(bundleItem)
      .where(this.scope(eq(bundleItem.bundleId, bundleId)))
      .get();
    return row?.total ?? null;
  }

  /**
   * Every bundle's total in one grouped query. `GET /api/bundles` renders a
   * savings column per row, so a per-bundle sum would be N+1 across the list.
   */
  async sumsByBundle(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        bundleId: bundleItem.bundleId,
        total: sql<number>`sum(${bundleItem.price} * ${bundleItem.qty})`,
      })
      .from(bundleItem)
      .where(this.scope())
      .groupBy(bundleItem.bundleId)
      .all();
    return new Map(rows.map((r) => [r.bundleId, r.total]));
  }
}
```

- [ ] **Step 4: Register it**

In `src/db/repositories/index.ts`, add the import, the re-exports, the `Repositories` field and the construction:

```ts
import { BundleItemRepository, type IBundleItemRepository } from './BundleItemRepository';

export { BundleItemRepository } from './BundleItemRepository';
export type {
  IBundleItemRepository,
  BundleItemRow,
  BundleItemNew,
  BundleItemDraft,
} from './BundleItemRepository';
```

In `interface Repositories`, after `bundles`:

```ts
  bundleItems: IBundleItemRepository;
```

In `createRepositoriesFromDb`, after `bundles`:

```ts
    bundleItems: new BundleItemRepository(db, shopId),
```

- [ ] **Step 5: Add the in-memory fake**

In `src/db/repositories/inMemory.ts`, add the import and the class, then wire it into `InMemoryRepositories` and `createInMemoryRepositories`:

```ts
import type {
  IBundleItemRepository,
  BundleItemRow,
  BundleItemNew,
  BundleItemDraft,
} from './BundleItemRepository';

export class InMemoryBundleItemRepository
  extends InMemoryBase<BundleItemRow, BundleItemNew>
  implements IBundleItemRepository
{
  protected readonly table = 'bundle_item';

  constructor(
    public readonly shopId: string,
    rows: BundleItemRow[] = [],
  ) {
    super(rows);
  }

  protected override inScope(row: BundleItemRow): boolean {
    return row.shopId === this.shopId;
  }

  protected materialize(data: NewRow<BundleItemNew>, id: string, now: string): BundleItemRow {
    return {
      priceAdjustment: null,
      titleOverride: null,
      ...data,
      id,
      shopId: this.shopId,
      createdAt: now,
      updatedAt: now,
    } as BundleItemRow;
  }

  async listForBundle(bundleId: string): Promise<BundleItemRow[]> {
    return this.rows
      .filter((r) => this.inScope(r) && r.bundleId === bundleId)
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async replaceForBundle(bundleId: string, items: BundleItemDraft[]): Promise<BundleItemRow[]> {
    const now = new Date().toISOString();
    this.rows = this.rows.filter((r) => !(this.inScope(r) && r.bundleId === bundleId));
    const created = items.map((item) => ({
      priceAdjustment: null,
      titleOverride: null,
      ...item,
      id: crypto.randomUUID(),
      shopId: this.shopId,
      bundleId,
      createdAt: now,
      updatedAt: now,
    }) as BundleItemRow);
    this.rows.push(...created);
    return created.map((r) => ({ ...r }));
  }

  async sumFor(bundleId: string): Promise<number | null> {
    const rows = await this.listForBundle(bundleId);
    if (rows.length === 0) return null;
    return rows.reduce((total, r) => total + r.price * r.qty, 0);
  }

  async sumsByBundle(): Promise<Map<string, number>> {
    const sums = new Map<string, number>();
    for (const r of this.rows) {
      if (!this.inScope(r)) continue;
      sums.set(r.bundleId, (sums.get(r.bundleId) ?? 0) + r.price * r.qty);
    }
    return sums;
  }
}
```

In `InMemoryRepositories` add `bundleItems: InMemoryBundleItemRepository;`, in the seed type add `bundleItems?: BundleItemRow[];`, and in `createInMemoryRepositories` add:

```ts
    bundleItems: new InMemoryBundleItemRepository(shopId, seed.bundleItems ?? []),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/db/repositories && npx tsc --noEmit`
Expected: the six new tests pass; existing repository tests still pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories
git commit -m "feat(db): add BundleItemRepository

replaceForBundle swaps a bundle's whole component set in one db.batch().
D1 has no interactive transactions, so a delete-then-insert as separate
statements can leave a bundle with no components if the insert fails.

sumsByBundle exists because GET /api/bundles renders a savings column for
every row, and a per-bundle sum would be N+1 across the list."
```

---

### Task 5: Bundle read path (GET list, GET :id)

**Files:**
- Modify: `src/routes/bundles.ts:16-120` (types, `toDto`, list handler), `:164-171` (detail handler)
- Modify: `src/api.integration.test.ts` (the `bundleRow` helper and the bundle GET tests)

**Interfaces:**
- Consumes: `toMoney`, `MoneyV2` (Task 1); `IBundleItemRepository` (Task 4).
- Produces: `interface BundleItemDto { variantId: string; name: string; qty: number; price: MoneyV2; priceAdjustment?: MoneyV2; titleOverride?: string }`, `interface BundleDto { …; items: BundleItemDto[]; price: MoneyV2 | null; sumOfItems: MoneyV2 | null; … }`, `async function shopCurrency(c): Promise<string>`.

- [ ] **Step 1: Write the failing test**

In `src/api.integration.test.ts`, replace the `bundleRow` helper with one that has no `items`/`sumOfItems`, add a `bundleItemRow` helper, and add these tests to the bundles describe block:

```ts
/** A complete `bundle` row; override only what the test is about. */
const bundleRow = (overrides: Partial<BundleRow> = {}): BundleRow => ({
  id: 'bundle-1',
  shopId: SHOP.id,
  name: 'Camp Kit',
  operation: 'merge',
  parentVariantId: null,
  price: 2999, // minor units => A$29.99
  metafieldState: 'NotYet',
  metafieldGid: null,
  scheduleStart: null,
  scheduleEnd: null,
  status: 'Draft',
  blockOnFailure: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

/** A complete `bundle_item` row. */
const bundleItemRow = (overrides: Partial<BundleItemRow> = {}): BundleItemRow => ({
  id: 'item-1',
  shopId: SHOP.id,
  bundleId: 'bundle-1',
  variantId: 'gid://shopify/ProductVariant/1',
  name: 'Blue T-Shirt / Large',
  qty: 2,
  price: 1500, // minor units => A$15.00
  priceAdjustment: null,
  titleOverride: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

it('GET /api/bundles computes sumOfItems from the item rows', async () => {
  seed({
    shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })],
    bundles: [bundleRow({ id: 'bundle-1', price: 2999 })],
    bundleItems: [
      bundleItemRow({ id: 'i1', bundleId: 'bundle-1', qty: 2, price: 1500 }),
      bundleItemRow({ id: 'i2', bundleId: 'bundle-1', variantId: 'gid://shopify/ProductVariant/2', name: 'Cap', qty: 1, price: 999 }),
    ],
  });

  const res = await request('/api/bundles');
  const json = await res.json() as { bundles: { sumOfItems: { amount: string; currencyCode: string } }[] };

  // 2 x 1500 + 1 x 999 = 3999
  expect(json.bundles[0].sumOfItems).toEqual({ amount: '39.99', currencyCode: 'AUD' });
});

it('GET /api/bundles/:id returns items ordered by name with MoneyV2 prices', async () => {
  seed({
    shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })],
    bundles: [bundleRow({ id: 'bundle-1' })],
    bundleItems: [
      bundleItemRow({ id: 'i1', name: 'Zebra Mug', variantId: 'gid://shopify/ProductVariant/9', price: 500, qty: 1 }),
      bundleItemRow({ id: 'i2', name: 'Anchor Tee', variantId: 'gid://shopify/ProductVariant/8', price: 2000, qty: 1 }),
    ],
  });

  const res = await request('/api/bundles/bundle-1');
  const json = await res.json() as { bundle: { items: { name: string; price: { amount: string } }[] } };

  expect(json.bundle.items.map((i) => i.name)).toEqual(['Anchor Tee', 'Zebra Mug']);
  expect(json.bundle.items[0].price).toEqual({ amount: '20.00', currencyCode: 'AUD' });
});

it('GET /api/bundles reports a null sum for a bundle with no items', async () => {
  seed({
    shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })],
    bundles: [bundleRow({ id: 'bundle-1' })],
    bundleItems: [],
  });

  const res = await request('/api/bundles');
  const json = await res.json() as { bundles: { sumOfItems: unknown }[] };

  expect(json.bundles[0].sumOfItems).toBeNull();
});
```

Add `BundleItemRow` to the type import from `./db/repositories`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts`
Expected: FAIL — type errors on `bundleItems` in the seed, and the DTO still returning plain numbers.

- [ ] **Step 3: Rewrite the DTO layer**

In `src/routes/bundles.ts`, replace the `BundleItem` / `BundleDto` types, the `toCents` / `toDollars` helpers and `toDto`:

```ts
import { toMinorUnits, toMoney, type MoneyV2 } from '../lib/money';
import type { BundleRow, BundleItemRow } from '../db/repositories';

type Row = BundleRow;

interface BundleItemDto {
  variantId: string;
  name: string;
  qty: number;
  price: MoneyV2;
  priceAdjustment?: MoneyV2;
  titleOverride?: string;
}

interface BundleDto {
  id: string;
  name: string;
  operation: 'merge' | 'expand' | 'update';
  items: BundleItemDto[];
  parentVariantId?: string;
  price: MoneyV2 | null;
  sumOfItems: MoneyV2 | null;
  status: 'Active' | 'Scheduled' | 'Ended' | 'Draft';
  metafieldState: 'NotYet' | 'Written' | 'Cleared';
  metafieldGid?: string;
  updated: string;
}

/**
 * The caller's shop currency. Every money value crossing this boundary needs
 * it, and a shop row without one is a data-integrity problem rather than a
 * reason to guess USD — `toMoney` would silently store JPY off by 100.
 */
async function shopCurrency(c: Context<AppEnv>): Promise<string> {
  const shop = await c.get('repos').shops.findById(c.get('shopId'));
  if (!shop?.currency) {
    throw new Error(`[bundles] shop ${c.get('shopId')} has no currency on its row`);
  }
  return shop.currency;
}

function toItemDto(row: BundleItemRow, currency: string): BundleItemDto {
  return {
    variantId: row.variantId,
    name: row.name,
    qty: row.qty,
    price: toMoney(row.price, currency)!,
    ...(row.priceAdjustment !== null
      ? { priceAdjustment: toMoney(row.priceAdjustment, currency)! }
      : {}),
    ...(row.titleOverride ? { titleOverride: row.titleOverride } : {}),
  };
}

function toDto(
  row: Row,
  items: BundleItemRow[],
  sumOfItems: number | null,
  currency: string,
): BundleDto {
  return {
    id: row.id,
    name: row.name,
    operation: row.operation,
    items: items.map((item) => toItemDto(item, currency)),
    ...(row.parentVariantId ? { parentVariantId: row.parentVariantId } : {}),
    price: toMoney(row.price, currency),
    sumOfItems: toMoney(sumOfItems, currency),
    status: row.status,
    metafieldState: row.metafieldState,
    ...(row.metafieldGid ? { metafieldGid: row.metafieldGid } : {}),
    updated: relativeTime(row.updatedAt),
  };
}
```

Add `import type { Context } from 'hono';` to the imports if it is not already there.

- [ ] **Step 4: Rewrite the two GET handlers**

```ts
// GET /api/bundles — the caller's shop's bundles plus a summary strip.
// `inCampaigns` is 0 until bundle campaigns land (E7). `avgSaving` is the mean
// per-bundle (sumOfItems - price) over bundles with both set.
//
// Item rows and their sums are fetched in TWO queries total, not two per
// bundle — see `sumsByBundle` / `findAll` below.
bundleRoutes.get('/api/bundles', async (c) => {
  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const currency = await shopCurrency(c);

  const rows = await bundleRepo.findAll();
  const sums = await bundleItems.sumsByBundle();
  const allItems = await bundleItems.findAll();

  const itemsByBundle = new Map<string, BundleItemRow[]>();
  for (const item of allItems) {
    const list = itemsByBundle.get(item.bundleId) ?? [];
    list.push(item);
    itemsByBundle.set(item.bundleId, list);
  }
  for (const list of itemsByBundle.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const bundles = rows.map((row) =>
    toDto(row, itemsByBundle.get(row.id) ?? [], sums.get(row.id) ?? null, currency),
  );

  const savings = rows
    .filter((r) => r.price !== null && sums.get(r.id) !== undefined)
    .map((r) => (sums.get(r.id) as number) - (r.price as number));
  // MoneyV2 | null, never 0 — "no bundles with a saving" is not "saves nothing".
  const avgSaving =
    savings.length === 0
      ? null
      : toMoney(Math.round(savings.reduce((sum, s) => sum + s, 0) / savings.length), currency);

  return c.json({
    bundles,
    summary: { count: bundles.length, inCampaigns: 0, avgSaving },
  });
});
```

And the detail handler:

```ts
// GET /api/bundles/:id — single row scoped to the caller's shop (404 when missing).
bundleRoutes.get('/api/bundles/:id', async (c) => {
  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const id = c.req.param('id');

  const row = await bundleRepo.findById(id);
  if (!row) return c.json({ error: 'Bundle not found' }, 404);

  const currency = await shopCurrency(c);
  const items = await bundleItems.listForBundle(id);
  const sum = await bundleItems.sumFor(id);

  return c.json({ bundle: toDto(row, items, sum, currency) });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/api.integration.test.ts && npx tsc --noEmit`
Expected: the read-path tests pass. The write-path tests (POST/PUT) still fail — Task 6 fixes them.

- [ ] **Step 6: Expose the shop currency to the editor**

The editor needs a currency code to format its live preview total, and it has no
way to get one today. It already calls `GET /api/shop/plan` (`BundleEditor.tsx:248`),
so add the field there rather than inventing an endpoint.

In `src/routes/shop.ts`, add `currencyCode` to the plan response:

```ts
  const shop = await shops.findById(shopId);
  if (!shop?.currency) {
    return c.json({ error: 'This shop has no currency on its row.' }, 500);
  }
  // …existing plan-signal logic…

  return c.json({
    shopifyPlus,
    partnerDevelopment,
    planName,
    currencyCode: shop.currency,
  });
```

Add a test in `src/api.integration.test.ts`:

```ts
it('GET /api/shop/plan includes the shop currency', async () => {
  seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD',
    shopifyPlus: 1, partnerDevelopment: 0, planName: 'Shopify Plus' })] });

  const res = await request('/api/shop/plan');
  const json = await res.json() as { currencyCode: string };

  expect(json.currencyCode).toBe('AUD');
});
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/bundles.ts src/routes/shop.ts src/api.integration.test.ts
git commit -m "feat(api): serve bundle items from bundle_item with MoneyV2

sumOfItems is now computed from the item rows rather than read from a
column that could disagree with them. Money crosses the boundary as
{amount, currencyCode} so no component can default to a dollar sign.

The list handler fetches items and sums in two queries for the whole
page rather than two per bundle."
```

---

### Task 6: Bundle write path (POST, PUT, DELETE)

**Files:**
- Modify: `src/routes/bundles.ts` (`BundleInput`, the POST handler, the PUT handler, the DELETE handler)
- Modify: `src/lib/bundleMetafields.ts` (`BundleItemLike.price` becomes required and in major units)
- Modify: `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `resolveVariants`, `variantDisplayName`, `VARIANT_GID` (Task 2); `toMinorUnits`, `toMoney` (Task 1); `IBundleItemRepository.replaceForBundle` (Task 4); `toItemDto`, `shopCurrency` (Task 5).
- Produces: `async function verifyItems(c: Context<AppEnv>, currency: string, items: BundleItemInput[], existing: BundleItemRow[], convertAdjustment: boolean): Promise<BundleItemDraft[]>`, `class HttpError`.

- [ ] **Step 1: Write the failing test**

Add to `src/api.integration.test.ts`:

```ts
it('POST /api/bundles overwrites the client price with Shopify’s', async () => {
  const repos = seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })] });
  vi.mocked(adminGraphql).mockResolvedValue({
    data: { nodes: [{
      id: 'gid://shopify/ProductVariant/1', title: 'Large', price: '15.00', image: null,
      product: { id: 'gid://shopify/Product/9', title: 'Blue T-Shirt', featuredImage: null },
    }] },
  } as never);

  const res = await request('/api/bundles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Camp Kit', operation: 'expand', parentVariantId: 'gid://shopify/ProductVariant/7',
      // A client claiming the item costs one cent.
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2, price: 0.01 }],
    }),
  });

  expect(res.status).toBe(201);
  expect(repos.bundleItems.rows[0].price).toBe(1500);
  expect(repos.bundleItems.rows[0].name).toBe('Blue T-Shirt / Large');
});

it('POST /api/bundles rejects a body containing sumOfItems', async () => {
  seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })] });

  const res = await request('/api/bundles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Camp Kit', operation: 'expand', parentVariantId: 'gid://shopify/ProductVariant/7',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
      sumOfItems: 99.99,
    }),
  });

  expect(res.status).toBe(400);
  expect((await res.json() as { error: string }).error).toMatch(/sumOfItems/);
});

it('POST /api/bundles rejects a variant that does not exist', async () => {
  seed({ shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })] });
  vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [null] } } as never);

  const res = await request('/api/bundles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Camp Kit', operation: 'expand', parentVariantId: 'gid://shopify/ProductVariant/7',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
    }),
  });

  expect(res.status).toBe(400);
  expect((await res.json() as { error: string }).error).toMatch(/ProductVariant\/1/);
});

it('PUT /api/bundles/:id keeps a deleted variant’s stored price and name', async () => {
  const repos = seed({
    shops: [shopRow({ ...SHOP, status: 'installed', currency: 'AUD' })],
    bundles: [bundleRow({ id: 'bundle-1', operation: 'expand', parentVariantId: 'gid://shopify/ProductVariant/7' })],
    bundleItems: [bundleItemRow({ id: 'i1', bundleId: 'bundle-1', variantId: 'gid://shopify/ProductVariant/1', name: 'Blue T-Shirt / Large', price: 1500, qty: 2 })],
  });
  vi.mocked(adminGraphql).mockResolvedValue({ data: { nodes: [null] } } as never);

  const res = await request('/api/bundles/bundle-1', {
    method: 'PUT',
    body: JSON.stringify({ name: 'Renamed' }),
  });

  expect(res.status).toBe(200);
  const kept = repos.bundleItems.rows.find((r) => r.variantId === 'gid://shopify/ProductVariant/1');
  expect(kept?.price).toBe(1500);
  expect(kept?.name).toBe('Blue T-Shirt / Large');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts`
Expected: FAIL — the POST handler still writes `items` JSON.

- [ ] **Step 3: Write the verification helper**

In `src/routes/bundles.ts`, replace the `BundleItem` input interface and add the verifier:

```ts
import {
  resolveVariants,
  variantDisplayName,
  VARIANT_GID,
} from '../lib/variantResolver';
import type { BundleItemDraft } from '../db/repositories';

/** What a client posts per item. `price` is accepted but NOT trusted. */
interface BundleItemInput {
  variantId: string;
  qty: number;
  priceAdjustment?: number;
  titleOverride?: string;
  /** Ignored — the editor sends it for its live preview; the server re-resolves. */
  price?: number;
}

interface BundleInput {
  name: string;
  operation: 'merge' | 'expand' | 'update';
  items: BundleItemInput[];
  parentVariantId?: string;
  price?: number; // major units
  status?: 'Active' | 'Scheduled' | 'Ended' | 'Draft';
}

/**
 * Re-resolves every item's price and name from Shopify in ONE Admin call, and
 * returns the rows to store.
 *
 * Client-sent prices are discarded. They exist so the editor can show a running
 * total while the merchant picks; they are not a source of truth, and for an
 * `expand` bundle they would flow straight into the `composition_v2` metafield
 * the Rust cart-transform function reads at checkout.
 *
 * A variant that no longer resolves keeps whatever price and name its existing
 * row holds. On a create there is no such row, so the save is rejected —
 * `bundle_item.price` is NOT NULL and there is nothing honest to put in it.
 */
async function verifyItems(
  c: Context<AppEnv>,
  currency: string,
  items: BundleItemInput[],
  existing: BundleItemRow[],
  // False when `items` was rebuilt from stored rows on a PUT that did not send
  // any: those `priceAdjustment` values are ALREADY in minor units, and running
  // them through `toMinorUnits` again would scale them by the exponent twice.
  convertAdjustment: boolean,
): Promise<BundleItemDraft[]> {
  const adjustment = (value: number | undefined): number | null => {
    if (value === undefined) return null;
    return convertAdjustment ? toMinorUnits(value, currency) : value;
  };
  const malformed = items.filter((i) => !VARIANT_GID.test(i.variantId));
  if (malformed.length > 0) {
    throw new HttpError(400, `Not ProductVariant ids: ${malformed.map((i) => i.variantId).join(', ')}`);
  }

  const shopDomain = requireShopDomain(c);
  let resolved;
  try {
    resolved = await resolveVariants(shopDomain, c.env, items.map((i) => i.variantId));
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }

  const priorByVariant = new Map(existing.map((row) => [row.variantId, row]));

  return items.map((item) => {
    const live = resolved.get(item.variantId);
    const prior = priorByVariant.get(item.variantId);

    if (live?.exists && live.price !== undefined) {
      return {
        variantId: item.variantId,
        name: variantDisplayName(live) ?? item.variantId,
        qty: item.qty,
        price: toMinorUnits(live.price, currency),
        priceAdjustment: adjustment(item.priceAdjustment),
        titleOverride: item.titleOverride ?? null,
      };
    }

    if (!prior) {
      throw new HttpError(
        400,
        `${item.variantId} no longer exists in Shopify, so its price can't be determined. Remove it from the bundle.`,
      );
    }

    // Deleted, but we already hold what it cost and what it was called.
    return {
      variantId: item.variantId,
      name: prior.name,
      qty: item.qty,
      price: prior.price,
      priceAdjustment: adjustment(item.priceAdjustment),
      titleOverride: item.titleOverride ?? null,
    };
  });
}

/** Lets `verifyItems` fail with a status without every caller re-checking. */
class HttpError extends Error {
  constructor(public readonly status: 400 | 502, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
```

- [ ] **Step 4: Rewire POST**

In the POST handler, after the existing validation guards, replace the row construction and insert:

```ts
  if ((body as { sumOfItems?: unknown }).sumOfItems !== undefined) {
    return c.json(
      { error: 'sumOfItems is computed from the bundle’s items and cannot be set.' },
      400,
    );
  }

  const { bundles: bundleRepo, bundleItems } = c.get('repos');
  const currency = await shopCurrency(c);

  let drafts: BundleItemDraft[];
  try {
    drafts = await verifyItems(c, currency, body.items, [], true);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const row: Row = await bundleRepo.create({
    name: body.name,
    operation: body.operation,
    parentVariantId: body.parentVariantId ?? null,
    price: body.price === undefined ? null : toMinorUnits(body.price, currency),
    metafieldState: 'NotYet',
    metafieldGid: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: body.status ?? 'Draft',
    blockOnFailure: 0,
  });

  const itemRows = await bundleItems.replaceForBundle(row.id, drafts);
  const sum = await bundleItems.sumFor(row.id);
```

Every later reference to `body.items` in the metafield phase becomes `itemRows`, and each `toDto(row)` becomes `toDto(row, itemRows, sum, currency)`.

- [ ] **Step 5: Rewire PUT**

In the PUT handler, after loading `existing`:

```ts
  if ((body as { sumOfItems?: unknown }).sumOfItems !== undefined) {
    return c.json(
      { error: 'sumOfItems is computed from the bundle’s items and cannot be set.' },
      400,
    );
  }

  const currency = await shopCurrency(c);
  const existingItems = await bundleItems.listForBundle(id);

  // `effectiveItems` replaces the old JSON.parse of `existing.items`.
  const effectiveItems: BundleItemInput[] = body.items
    ?? existingItems.map((r) => ({
      variantId: r.variantId,
      qty: r.qty,
      ...(r.priceAdjustment !== null ? { priceAdjustment: r.priceAdjustment } : {}),
      ...(r.titleOverride ? { titleOverride: r.titleOverride } : {}),
    }));
```

Keep the existing expand-empty and merge-price guards, operating on `effectiveItems`. Then replace the patch/update block:

```ts
  const patch: Partial<Row> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.operation !== undefined) patch.operation = body.operation;
  if (body.parentVariantId !== undefined) patch.parentVariantId = body.parentVariantId;
  if (body.price !== undefined) patch.price = toMinorUnits(body.price, currency);
  if (body.status !== undefined) patch.status = body.status;

  let drafts: BundleItemDraft[];
  try {
    // `body.items` is in major units; rows rebuilt from storage are already minor.
    drafts = await verifyItems(c, currency, effectiveItems, existingItems, body.items !== undefined);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const merged: Row = await bundleRepo.update(id, patch);
  const itemRows = await bundleItems.replaceForBundle(id, drafts);
  const sum = await bundleItems.sumFor(id);
```


- [ ] **Step 6: Update the metafield helper**

In `src/lib/bundleMetafields.ts`, `BundleItemLike` now receives rows in minor units, so the caller converts. Change the interface and add the note:

```ts
/** Minimal shape `compositionFromItems` needs from a bundle item.
 *  `price` is per-unit in MAJOR units (dollars) — the Rust function's
 *  `BundleComponent.price` is a major-unit float, not minor units. The bundle
 *  routes convert from the stored minor units before calling in. */
export interface BundleItemLike {
  variantId: string;
  qty: number;
  price: number;
}
```

At each call site in `bundles.ts`, map the stored rows:

```ts
const forMetafield = itemRows.map((r) => ({
  variantId: r.variantId,
  qty: r.qty,
  price: Number(toMoney(r.price, currency)!.amount),
}));
```

- [ ] **Step 7: Rewire DELETE**

The `bundle_item` rows cascade on the FK, so the handler needs no change beyond `toDto` no longer being called with a bare row. Verify the DELETE handler still compiles and its test passes.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/routes/bundles.ts src/lib/bundleMetafields.ts src/api.integration.test.ts
git commit -m "feat(api): verify bundle item prices against Shopify on save

Client-sent prices are discarded and re-resolved in one Admin call. They
were reaching the composition_v2 metafield the Rust cart transform reads
at checkout, on nothing but the client's word.

A deleted variant keeps the price and name already on its row rather than
failing the edit, so a merchant can still open the bundle to fix it. A
create has no such row to fall back on, so it is rejected.

sumOfItems is rejected in the request body rather than ignored."
```

---

### Task 7: Frontend types and the shared money formatter

**Files:**
- Modify: `web/types/bundles.ts`
- Create: `web/lib/money.ts`
- Create: `web/lib/money.test.ts`
- Modify: `web/Pages/Bundles.tsx:20,156`
- Modify: `web/Pages/BundleEditor.tsx:45,420-460,643`
- Modify: `web/bundles/api.ts`

**Interfaces:**
- Consumes: the MoneyV2 DTO from Tasks 5 and 6.
- Produces: `interface MoneyV2 { amount: string; currencyCode: string }`, `formatMoney(money: MoneyV2 | null, locale?: string): string`, `moneyAmount(money: MoneyV2 | null): number | null`.

- [ ] **Step 1: Write the failing test**

Create `web/lib/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatMoney, moneyAmount } from './money';

describe('formatMoney', () => {
  it('formats in the currency it is given, not a hardcoded dollar', () => {
    expect(formatMoney({ amount: '29.99', currencyCode: 'AUD' }, 'en-AU')).toBe('$29.99');
    expect(formatMoney({ amount: '1000', currencyCode: 'JPY' }, 'en-AU')).toContain('1,000');
  });

  it('renders an em dash for an absent amount rather than $0.00', () => {
    expect(formatMoney(null)).toBe('—');
  });
});

describe('moneyAmount', () => {
  it('parses the decimal string for arithmetic', () => {
    expect(moneyAmount({ amount: '29.99', currencyCode: 'AUD' })).toBe(29.99);
  });

  it('passes null through', () => {
    expect(moneyAmount(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/lib/money.test.ts`
Expected: FAIL — `Failed to resolve import "./money"`.

- [ ] **Step 3: Write the formatter**

Create `web/lib/money.ts`:

```ts
/** Shopify's MoneyV2 shape, as the bundles API sends it. */
export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

/**
 * The one money formatter. Replaces the two hardcoded `$`/`en-US` helpers that
 * used to live in Bundles.tsx and BundleEditor.tsx — those rendered a JPY
 * amount as "¥1,000.00", which is both the wrong symbol and the wrong number
 * of decimals.
 */
export function formatMoney(money: MoneyV2 | null, locale = 'en'): string {
  if (!money) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currencyCode,
  }).format(Number(money.amount));
}

/** The numeric amount, for arithmetic like the savings column. Null stays null. */
export function moneyAmount(money: MoneyV2 | null): number | null {
  return money === null ? null : Number(money.amount);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run web/lib/money.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Update the frontend types**

In `web/types/bundles.ts`:

```ts
import type { MoneyV2 } from '../lib/money';

export type { MoneyV2 };

export interface BundleItem {
  variantId: string;
  name: string;
  qty: number;
  price: MoneyV2;
  priceAdjustment?: MoneyV2;
  titleOverride?: string;
}

export interface Bundle {
  id: string;
  name: string;
  operation: BundleOperation;
  items: BundleItem[];
  parentVariantId?: string;
  price: MoneyV2 | null;
  sumOfItems: MoneyV2 | null;
  status: BundleStatus;
  metafieldState: 'NotYet' | 'Written' | 'Cleared';
  metafieldGid?: string;
  updated: string;
}
```

In `web/bundles/api.ts`, delete `sumOfItems` from the input type — the server rejects it now.

- [ ] **Step 6: Update the two pages**

In `web/Pages/Bundles.tsx`, delete the local `money` helper on line 20, import the shared one, and change the savings computation on line 156:

```ts
import { formatMoney, moneyAmount } from '../lib/money';

// …savings column (was line 156):
const price = moneyAmount(b.price);
const sum = moneyAmount(b.sumOfItems);
const save = price != null && sum != null
  ? formatMoney({ amount: String(sum - price), currencyCode: b.price!.currencyCode })
  : null;
```

`summary.avgSaving` is now `MoneyV2 | null` rather than a number, so the default on line 81 and
the `Stat` on line 130 both change:

```ts
const summary = data?.summary ?? { count: 0, inCampaigns: 0, avgSaving: null };
// …
<Stat label="Avg. saving" value={formatMoney(summary.avgSaving)} />
```

`formatMoney(null)` renders an em dash, so an empty shop no longer claims an average saving of
`$0.00`.

In `web/Pages/BundleEditor.tsx`, delete the local `money` helper on line 45 and import the shared one.

**The editor keeps its draft items as plain numbers, not MoneyV2.** Two reasons: it has no
currency code at the moment the picker returns, and the server discards client prices anyway
(Task 6), so constructing a MoneyV2 for the wire would be ceremony around a value that is thrown
away. Declare the draft shape locally, distinct from the server's `BundleItem`:

```ts
/** What the editor holds while the merchant is picking. NOT the wire shape:
 *  `price` is a plain number for the live preview only — the server re-resolves
 *  every price from Shopify on save and ignores whatever we send. */
interface DraftItem {
  variantId: string;
  name: string;
  qty: number;
  price: number | null;
  priceAdjustment?: number;
  titleOverride?: string;
}
```

`items` becomes `useState<DraftItem[]>([])`. Hydrating from a loaded bundle converts down from
the wire shape:

```ts
setItems(bundle.items.map((it) => ({
  variantId: it.variantId,
  name: it.name,
  qty: it.qty,
  price: moneyAmount(it.price),
  ...(it.priceAdjustment ? { priceAdjustment: moneyAmount(it.priceAdjustment) ?? undefined } : {}),
  ...(it.titleOverride ? { titleOverride: it.titleOverride } : {}),
})));
```

The picker mapping (line 359) carries the name and the numeric price it already has:

```ts
const next = picked.map((v) => {
  const existing = prev.find((p) => p.variantId === v.variantId);
  return { variantId: v.variantId, name: v.title, qty: existing?.qty ?? 1, price: v.price ?? null };
});
```

The preview sum (line 420) is unchanged in shape:

```ts
const sumOfItems = items.reduce((sum, it) => sum + (it.price ?? 0) * it.qty, 0);
```

Formatting it needs a currency, which now comes from the plan query the editor already runs
(line 248, extended in Task 5 Step 6):

```ts
const currencyCode = planData?.currencyCode ?? 'USD';
const showMoney = (n: number) => formatMoney({ amount: String(n), currencyCode });
```

In `buildInput`, **delete the `sumOfItems` property** — the server rejects it — and send items
without prices:

```ts
items: items.map((it) => ({
  variantId: it.variantId,
  qty: it.qty,
  ...(it.priceAdjustment !== undefined ? { priceAdjustment: it.priceAdjustment } : {}),
  ...(it.titleOverride ? { titleOverride: it.titleOverride } : {}),
})),
```

Replace the three `money(...)` call sites (including line 643) with `showMoney(...)`.

- [ ] **Step 7: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npx eslint web --ext .ts,.tsx`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add web/lib/money.ts web/lib/money.test.ts web/types/bundles.ts web/Pages/Bundles.tsx web/Pages/BundleEditor.tsx web/bundles/api.ts
git commit -m "feat(web): one currency-aware money formatter

Replaces two copies of a helper that hardcoded a dollar sign and en-US,
which rendered a JPY amount as the wrong symbol with two decimals it
doesn't have. The editor also stops posting sumOfItems, which the server
now computes and rejects in the body."
```

---

### Task 8: Deleted-variant banner

**Files:**
- Modify: `web/Pages/BundleEditor.tsx`

**Interfaces:**
- Consumes: `ResolvedVariant.exists` from `GET /api/variants` (already fetched at load); `BundleItem.name` and `BundleItem.price` from the DTO (Task 7).
- Produces: nothing downstream.

- [ ] **Step 1: Note the testing gap explicitly**

`playwright-tests/` contains only `cloudflare-shopify-starter-template.spec.ts` — there is no
bundles spec and no component test harness for the editor, so this task has **no automated test**.
It is verified manually in Step 4.

This is the one task in the plan without a test cycle. Do not invent a brittle harness for it;
the logic being added is a filter and a render, and the underlying `exists: false` contract is
already covered by `src/lib/variantResolver.test.ts` (Task 2).

- [ ] **Step 2: Compute the dead items**

In `BundleEditor.tsx`, after the variant resolution effect that populates `titles`, derive the dead set from the same response. Store it alongside:

```ts
const [deadVariantIds, setDeadVariantIds] = useState<Set<string>>(new Set());

// …inside the resolve effect, from the /api/variants response:
setDeadVariantIds(new Set(
  resolved.variants.filter((v) => !v.exists).map((v) => v.id),
));
```

- [ ] **Step 3: Render the banner**

Above the existing `isUpdateLocked` banner:

```tsx
{deadItems.length > 0 && (
  <Banner tone="critical" title="Some products were deleted in Shopify">
    <BlockStack gap="200">
      {deadItems.map((item) => (
        <InlineStack key={item.variantId} gap="200" blockAlign="center">
          <Text as="span">
            <strong>{item.name}</strong> — {formatMoney(item.price)}
          </Text>
          <Button
            variant="plain"
            tone="critical"
            onClick={() => removeItem(item.variantId)}
          >
            Remove from bundle
          </Button>
        </InlineStack>
      ))}
      <Text as="span" variant="bodySm" tone="subdued">
        Their last known price is shown. Removing one takes effect when you save.
      </Text>
    </BlockStack>
  </Banner>
)}
```

with, next to the other derived values:

```ts
const deadItems = items.filter((it) => deadVariantIds.has(it.variantId));
```

`removeItem` already exists (line 412) and filters by `variantId`, so no new handler is needed.

- [ ] **Step 4: Verify manually**

Run: `npm run dev`, open a bundle, and confirm the banner appears for an item whose variant has been deleted in the dev store, naming the product and its last known price, and that clicking Remove drops it from the item list and a subsequent save persists that.

- [ ] **Step 5: Run the checks**

Run: `npx tsc --noEmit && npx eslint web --ext .ts,.tsx && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/Pages/BundleEditor.tsx
git commit -m "feat(web): name deleted variants in the bundle editor

A deleted variant resolves to nothing from Shopify, so the banner reads
the name and price snapshot stored on bundle_item. Without it the merchant
would see a bare numeric gid and have no way to tell what the component
was."
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all green
- [ ] `npx eslint web --ext .ts,.tsx` — clean
- [ ] `npx vite build && npx wrangler deploy --dry-run` — both succeed
- [ ] `grep -rn "sum_of_items\|sumOfItems.*column\|JSON.parse(row.items)" src web` — no hits
- [ ] `grep -rn "createDb\|drizzle-orm" src --include="*.ts" | grep -v "src/db/"` — no hits
- [ ] `docs/erd.dbml` renders in dbdiagram.io with `bundle_item` present and `bundle.items` gone
