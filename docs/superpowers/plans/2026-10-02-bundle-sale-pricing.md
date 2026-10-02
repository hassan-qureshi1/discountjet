# Bundle Sale Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A campaign puts its bundles on sale — for the campaign's window, each bundle's parent variant carries a reduced `price` with the component sum as `compareAtPrice`, so the saving shows on the product page instead of only at checkout.

**Architecture:** The sale rides the **existing** cron pass that already flips bundles at a window boundary — one sweep, one definition of what a window means. The restore guarantee rests entirely on one column, `pre_sale_price`: written once with the sale price, cleared only after Shopify confirms the restore, and the sole signal that a bundle is on sale. Nothing else in this app overwrites merchant data; this does, which is why that column's lifecycle is the plan's centre of gravity.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Vitest, React 18 + Shopify Polaris 13, Shopify Admin GraphQL `2026-04` (`productVariantsBulkUpdate`).

**Spec:** `docs/superpowers/specs/2026-10-02-bundle-sale-pricing-design.md`

## Global Constraints

- All IDs are `crypto.randomUUID()`. Timestamps are ISO 8601 strings stored as `text()`. Booleans are `integer` `0/1`. **Money is stored in minor units as `integer`.**
- Every shop-owned table carries a non-null `shopId` FK to `shopify_shop` with `onDelete: 'cascade'`. This plan adds columns to an existing table and no new tables.
- All D1 access goes through a repository — no `createDb()` or Drizzle query builder outside `src/db/repositories/`. Routes use `c.get('repos')`; the cron uses `reposFor(shopId)`.
- `docs/erd.dbml` is updated in the SAME commit as the `schema.ts` edit and the generated migration.
- All `/api/*` routes stay behind `requireShop`; `PUBLIC_API_PATHS` is untouched.
- Fail loudly — no `?? ''` or fallback masking a missing price, domain, id or token.
- Return `null`, never `undefined`, for a miss.
- Frontend: Polaris components only; backend calls through `apiFetch`; spinner on load and `Banner` on error for every async UI. `web/`'s ESLint forbids `for...of` and `continue`.
- `npm run lint:ci` lints `web/` only; `src/` is not linted in this repo.

**The three states, copied from the spec — every task's code must agree with this table:**

| | parent variant's `price` in Shopify | `compareAtPrice` |
|---|---|---|
| Before sale | whatever the merchant set (normally the component sum) | sum of components |
| During sale | `bundle.price` | sum of components |
| After sale | restored to exactly its pre-sale value | sum of components |

## Review Focus

Five failure modes the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **A second activation pass while already on sale** must not re-capture `pre_sale_price` — it would record the *sale* price as the original, and the real price would be lost for good. (Task 2)
2. **A failed restore must leave the bundle restorable.** If `pre_sale_price` were cleared before Shopify confirmed, a rejected write would strand the sale permanently with nothing left to restore from. (Task 3)
3. **A bundle whose campaign was deleted mid-sale** must still restore — `bundle.campaign_id` is `ON DELETE SET NULL`, so the restore cannot depend on the campaign existing. (Task 3)
4. **A bundle with no `parentVariantId`** cannot be priced at all; it must be skipped with a recorded reason rather than throwing and aborting the whole shop's sweep. (Task 3)
5. **Editing a bundle during its own sale** must not be rejected by `assertExpandPriceBelowParent`, which compares against a parent price the sale itself lowered. (Task 5)

---

## File Structure

**Create:**
- `src/lib/variantPricing.ts` (+ test) — the Admin write: set and restore a variant's price/compare-at. One responsibility, no scheduling knowledge.
- `src/lib/salePrice.ts` (+ test) — pure decisions: what a bundle's sale and restore values are, and whether a pass should act. No I/O, so the risky logic is testable without mocks.

**Modify:**
- `src/db/schema.ts`, `docs/erd.dbml`, `drizzle/migrations/` — `compare_at_price`, `pre_sale_price`.
- `src/lifecycle/bundleSchedule.ts` — apply/restore inside the existing branch; new transport.
- `src/routes/bundles.ts` — accept and return `compareAtPrice`; relax the parent-price check during a sale.
- `web/bundles/api.ts`, `web/Pages/BundleEditor.tsx` — compare-at field; lock price while a campaign owns the bundle.

---

## Task 1: Schema — `compare_at_price` and `pre_sale_price`

**Files:**
- Modify: `src/db/schema.ts`, `docs/erd.dbml`
- Create: `drizzle/migrations/00NN_*.sql` (generated)

**Interfaces:**
- Produces: `bundle.compareAtPrice: number | null`, `bundle.preSalePrice: number | null` (both minor units).

- [ ] **Step 1: Add the columns**

In `src/db/schema.ts`, inside the `bundle` table, after `price`:

```ts
    /**
     * What to publish as the parent variant's `compareAtPrice`, in minor
     * units. Null means "use the sum of the components", so an existing
     * bundle needs no backfill and a merchant who never touches this field
     * still gets an honest strikethrough.
     */
    compareAtPrice: integer('compare_at_price'),
    /**
     * The parent variant's own price, captured immediately BEFORE the first
     * sale write, in minor units. This column is the entire restore
     * guarantee, and the only place in this app that holds merchant data we
     * are about to overwrite:
     *
     *  - written ONCE, in the same update that applies the sale price, and
     *    never while already non-null — otherwise a second activation pass
     *    would capture the SALE price as if it were the original and the real
     *    price would be gone;
     *  - cleared ONLY after Shopify confirms the restore, so a rejected
     *    restore leaves the row visibly mid-sale for the next pass to retry;
     *  - the signal for "this bundle is on sale", independent of campaign
     *    status, so a bundle restores even if its campaign was deleted.
     */
    preSalePrice: integer('pre_sale_price'),
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run d1:generate && npm run d1:migrate:local`

Expected: two `ALTER TABLE bundle ADD ...` statements. **Read the generated SQL before committing.** If it contains `DROP TABLE` (a SQLite table rebuild), stop and report — applying it would destroy live bundle rows.

- [ ] **Step 3: Mirror both columns in the ERD**

Add `compare_at_price` and `pre_sale_price` to the `bundle` table in `docs/erd.dbml`, following the file's existing style, each with a `note` saying it is minor units and what null means.

- [ ] **Step 4: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS. Fixtures that build a `BundleRow` literal need `compareAtPrice: null, preSalePrice: null` added.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts docs/erd.dbml drizzle/migrations src/api.integration.test.ts src/db/repositories/inMemory.ts
git commit -m "feat(bundles): add compare_at_price and pre_sale_price"
```

---

## Task 2: `salePrice.ts` — the pure decisions

**Files:**
- Create: `src/lib/salePrice.ts`, `src/lib/salePrice.test.ts`

**Interfaces:**
- Produces:
  - `interface SaleInputs { price: number | null; compareAtPrice: number | null; preSalePrice: number | null; componentSumMinor: number }`
  - `type SaleAction = { kind: 'apply'; priceMinor: number; compareAtMinor: number; capturePreSaleFrom: 'live' } | { kind: 'restore'; priceMinor: number; compareAtMinor: number } | { kind: 'none'; reason: string }`
  - `decideSaleAction(inputs: SaleInputs, shouldBeLive: boolean): SaleAction`
  - `compareAtMinorFor(inputs: Pick<SaleInputs, 'compareAtPrice' | 'componentSumMinor'>): number`

Keeping this pure is deliberate: it is the logic that can lose a merchant's price, and it must be testable exhaustively without mocking Shopify.

- [ ] **Step 1: Write the failing test**

Create `src/lib/salePrice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compareAtMinorFor, decideSaleAction } from './salePrice';

const base = { price: 279000, compareAtPrice: null, preSalePrice: null, componentSumMinor: 310000 };

describe('compareAtMinorFor', () => {
  it('uses the component sum when the merchant set no compare-at', () => {
    expect(compareAtMinorFor({ compareAtPrice: null, componentSumMinor: 310000 })).toBe(310000);
  });

  it('prefers the merchant’s own compare-at when they set one', () => {
    expect(compareAtMinorFor({ compareAtPrice: 350000, componentSumMinor: 310000 })).toBe(350000);
  });
});

describe('decideSaleAction', () => {
  it('applies the sale price and the component sum when the window opens', () => {
    expect(decideSaleAction(base, true)).toEqual({
      kind: 'apply', priceMinor: 279000, compareAtMinor: 310000, capturePreSaleFrom: 'live',
    });
  });

  // Review Focus #1 — the failure that loses the real price for good.
  it('does NOT re-apply while already on sale, so pre_sale_price is never recaptured', () => {
    const onSale = { ...base, preSalePrice: 310000 };

    const action = decideSaleAction(onSale, true);

    expect(action.kind).toBe('none');
  });

  it('restores exactly the captured price when the window closes', () => {
    const onSale = { ...base, preSalePrice: 310000 };

    expect(decideSaleAction(onSale, false)).toEqual({
      kind: 'restore', priceMinor: 310000, compareAtMinor: 310000,
    });
  });

  it('does nothing when the window is closed and the bundle was never on sale', () => {
    expect(decideSaleAction(base, false).kind).toBe('none');
  });

  it('refuses to apply a sale with no bundle price rather than pricing at zero', () => {
    const action = decideSaleAction({ ...base, price: null }, true);

    expect(action.kind).toBe('none');
    if (action.kind !== 'none') throw new Error('expected none');
    expect(action.reason).toMatch(/price/i);
  });

  it('restores even when the bundle price was cleared meanwhile', () => {
    // The restore must not depend on the sale price still being set — the
    // captured original is all it needs.
    const action = decideSaleAction({ ...base, price: null, preSalePrice: 310000 }, false);

    expect(action).toMatchObject({ kind: 'restore', priceMinor: 310000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/salePrice.test.ts`
Expected: FAIL — cannot resolve `./salePrice`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * What a sale pass should do to one bundle, decided without touching Shopify
 * or the database.
 *
 * Pure on purpose: this is the logic that can overwrite — and therefore lose —
 * a merchant's own price, so it is exhaustively testable with no mocks. The
 * caller performs the I/O; this only says what should happen.
 */
export interface SaleInputs {
  /** The bundle's sale price, in minor units. Null means none is set. */
  price: number | null;
  /** The merchant's compare-at override, minor units, or null for "use the sum". */
  compareAtPrice: number | null;
  /** The captured pre-sale price, minor units. Non-null means ON SALE NOW. */
  preSalePrice: number | null;
  /** Sum of the components' prices, minor units. */
  componentSumMinor: number;
}

export type SaleAction =
  | { kind: 'apply'; priceMinor: number; compareAtMinor: number; capturePreSaleFrom: 'live' }
  | { kind: 'restore'; priceMinor: number; compareAtMinor: number }
  | { kind: 'none'; reason: string };

/** The strikethrough is a standing property of a bundle, not of the sale. */
export function compareAtMinorFor(
  inputs: Pick<SaleInputs, 'compareAtPrice' | 'componentSumMinor'>,
): number {
  return inputs.compareAtPrice ?? inputs.componentSumMinor;
}

export function decideSaleAction(inputs: SaleInputs, shouldBeLive: boolean): SaleAction {
  const onSale = inputs.preSalePrice !== null;
  const compareAtMinor = compareAtMinorFor(inputs);

  if (shouldBeLive) {
    // Already on sale: doing nothing is not an optimisation, it is the
    // guarantee. Re-applying would capture the CURRENT (sale) price as the
    // pre-sale one and the merchant's real price would be unrecoverable.
    if (onSale) return { kind: 'none', reason: 'already on sale' };
    if (inputs.price === null) {
      return { kind: 'none', reason: 'bundle has no price to put on sale' };
    }
    return {
      kind: 'apply',
      priceMinor: inputs.price,
      compareAtMinor,
      capturePreSaleFrom: 'live',
    };
  }

  // Window closed. Restore is driven by the captured price alone — not by the
  // campaign, which may be gone, nor by the sale price, which may have been
  // cleared since.
  if (!onSale) return { kind: 'none', reason: 'not on sale' };
  return { kind: 'restore', priceMinor: inputs.preSalePrice as number, compareAtMinor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/salePrice.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/salePrice.ts src/lib/salePrice.test.ts
git commit -m "feat(bundles): decide a bundle's sale and restore prices"
```

---

## Task 3: `variantPricing.ts` — the Admin write, and the cron wiring

**Files:**
- Create: `src/lib/variantPricing.ts`, `src/lib/variantPricing.test.ts`
- Modify: `src/lifecycle/bundleSchedule.ts`, `src/lifecycle/bundleSchedule.test.ts`

**Interfaces:**
- Consumes: `decideSaleAction`, `compareAtMinorFor` (Task 2); `adminGraphql` from `./graphqlAdmin`; `toMinorUnits` from `./money`.
- Produces:
  - `readVariantPrice(env: Env, shopDomain: string, variantGid: string): Promise<{ priceMinor: number; currencyCode: string } | null>`
  - `setVariantPricing(env, shopDomain, variantGid, { priceMinor, compareAtMinor, currencyCode }): Promise<void>`
  - `BundleTransports` gains `readVariantPrice` and `setVariantPricing` with those signatures.

- [ ] **Step 1: Write the failing test for the Admin write**

Create `src/lib/variantPricing.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { readVariantPrice, setVariantPricing } from './variantPricing';
import type { Env } from '../types/env';

const env = {} as Env;
const SHOP = 'test-shop.myshopify.com';
const VARIANT = 'gid://shopify/ProductVariant/1';

beforeEach(() => vi.mocked(adminGraphql).mockReset());

describe('readVariantPrice', () => {
  it('returns the live price in minor units with the shop currency', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        productVariant: { id: VARIANT, price: '3100.00', product: { id: 'gid://shopify/Product/9' } },
        shop: { currencyCode: 'USD' },
      },
    } as never);

    await expect(readVariantPrice(env, SHOP, VARIANT)).resolves.toEqual({
      priceMinor: 310000, currencyCode: 'USD',
    });
  });

  it('returns null for a variant that no longer exists', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { productVariant: null, shop: { currencyCode: 'USD' } },
    } as never);

    await expect(readVariantPrice(env, SHOP, VARIANT)).resolves.toBeNull();
  });
});

describe('setVariantPricing', () => {
  it('writes price and compareAtPrice in major units for the product that owns the variant', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          productVariant: { id: VARIANT, price: '3100.00', product: { id: 'gid://shopify/Product/9' } },
          shop: { currencyCode: 'USD' },
        },
      } as never)
      .mockResolvedValueOnce({
        data: { productVariantsBulkUpdate: { productVariants: [{ id: VARIANT }], userErrors: [] } },
      } as never);

    await setVariantPricing(env, SHOP, VARIANT, {
      priceMinor: 279000, compareAtMinor: 310000, currencyCode: 'USD',
    });

    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[1];
    expect(String(query)).toContain('productVariantsBulkUpdate');
    expect(variables).toMatchObject({
      productId: 'gid://shopify/Product/9',
      variants: [{ id: VARIANT, price: '2790.00', compareAtPrice: '3100.00' }],
    });
  });

  it('throws on userErrors rather than reporting a write that did not happen', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          productVariant: { id: VARIANT, price: '3100.00', product: { id: 'gid://shopify/Product/9' } },
          shop: { currencyCode: 'USD' },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          productVariantsBulkUpdate: {
            productVariants: null,
            userErrors: [{ field: ['price'], message: 'Price must be positive' }],
          },
        },
      } as never);

    await expect(
      setVariantPricing(env, SHOP, VARIANT, {
        priceMinor: 279000, compareAtMinor: 310000, currencyCode: 'USD',
      }),
    ).rejects.toThrow(/Price must be positive/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/variantPricing.test.ts`
Expected: FAIL — cannot resolve `./variantPricing`.

- [ ] **Step 3: Write `variantPricing.ts`**

`productVariantsBulkUpdate` requires the owning **product** id as well as the variant id, which is why the write reads the variant first.

```ts
import { adminGraphql } from './graphqlAdmin';
import { currencyExponent, toMinorUnits } from './money';
import type { Env } from '../types/env';

const VARIANT_PRICE_QUERY = `
  query BundleVariantPrice($id: ID!) {
    productVariant(id: $id) { id price product { id } }
    shop { currencyCode }
  }
`;

const VARIANT_PRICE_MUTATION = `
  mutation SetBundleVariantPricing($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface VariantPriceResponse {
  productVariant: { id: string; price: string; product: { id: string } } | null;
  shop: { currencyCode: string };
}

/** Minor units, so it can be stored and compared without float drift. */
export async function readVariantPrice(
  env: Env,
  shopDomain: string,
  variantGid: string,
): Promise<{ priceMinor: number; currencyCode: string } | null> {
  const res = await adminGraphql<VariantPriceResponse>(
    shopDomain, env, VARIANT_PRICE_QUERY, { id: variantGid },
  );
  if (res.errors && res.errors.length > 0) {
    throw new Error(`[readVariantPrice] ${variantGid}: ${JSON.stringify(res.errors)}`);
  }
  const node = res.data?.productVariant;
  // Deleted in Shopify: report absence rather than inventing a price, so the
  // caller records a reason instead of pricing against a guess.
  if (!node) return null;
  const currencyCode = res.data!.shop.currencyCode;
  return { priceMinor: toMinorUnits(node.price, currencyCode), currencyCode };
}

/**
 * Major units as a decimal string is what the Admin API speaks. Uses the
 * shop's own exponent via `currencyExponent`, so a zero-decimal currency
 * (JPY) is not silently divided by 100.
 */
function toMajorString(minor: number, currencyCode: string): string {
  const digits = currencyExponent(currencyCode);
  return (minor / 10 ** digits).toFixed(digits);
}

export async function setVariantPricing(
  env: Env,
  shopDomain: string,
  variantGid: string,
  values: { priceMinor: number; compareAtMinor: number; currencyCode: string },
): Promise<void> {
  const current = await adminGraphql<VariantPriceResponse>(
    shopDomain, env, VARIANT_PRICE_QUERY, { id: variantGid },
  );
  const productId = current.data?.productVariant?.product.id;
  if (!productId) {
    throw new Error(`[setVariantPricing] ${variantGid} no longer exists in Shopify`);
  }

  const res = await adminGraphql<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string }> | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(shopDomain, env, VARIANT_PRICE_MUTATION, {
    productId,
    variants: [{
      id: variantGid,
      price: toMajorString(values.priceMinor, values.currencyCode),
      compareAtPrice: toMajorString(values.compareAtMinor, values.currencyCode),
    }],
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(`[setVariantPricing] ${variantGid}: ${JSON.stringify(res.errors)}`);
  }
  const userErrors = res.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`[setVariantPricing] ${variantGid}: ${userErrors.map((e) => e.message).join('; ')}`);
  }
  // Fail loudly on a response that reports neither an error nor a write: the
  // caller is about to record a price change that may not have happened.
  if (!res.data?.productVariantsBulkUpdate?.productVariants?.length) {
    throw new Error(`[setVariantPricing] ${variantGid}: no variant returned`);
  }
}
```

`currencyExponent` and `toMinorUnits` are existing exports of `src/lib/money.ts`; `toMajorString` is local to this file because nothing else needs it. If a later task wants it, move it into `money.ts` rather than copying it.

- [ ] **Step 4: Write the failing cron test**

Add to `src/lifecycle/bundleSchedule.test.ts`. That file already has `shop()`, `bundleRow()`, `noopTransports()` and `harness()` helpers — extend `noopTransports` with the two new transports and use the existing `harness`:

```ts
function pricingTransports(over: Partial<BundleTransports> = {}): BundleTransports {
  return {
    ...noopTransports(),
    readVariantPrice: vi.fn(async () => ({ priceMinor: 310000, currencyCode: 'USD' })),
    setVariantPricing: vi.fn(async () => {}),
    ...over,
  };
}

const PARENT = 'gid://shopify/ProductVariant/1';

it('captures the pre-sale price and applies the sale when a window opens', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 's1', operation: 'expand', parentVariantId: PARENT,
      price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
    })],
    [shop('s1')],
    t,
  );

  await runBundleSchedule(ENV, h.deps, NOW);

  expect(t.setVariantPricing).toHaveBeenCalledWith(
    ENV, 's1.myshopify.com', PARENT,
    expect.objectContaining({ priceMinor: 279000 }),
  );
  // The live price just read is what must be captured — not the sale price.
  expect(h.rowsFor('s1')[0]).toMatchObject({ preSalePrice: 310000, status: 'Active' });
});

// Review Focus #2 — the restore must stay possible after a failed write.
it('leaves pre_sale_price set when the restore write fails, so the next pass retries', async () => {
  const t = pricingTransports({
    setVariantPricing: vi.fn(async () => { throw new Error('Shopify said no'); }),
  });
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 's1', operation: 'expand', parentVariantId: PARENT,
      price: 279000, preSalePrice: 310000, status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('s1')],
    t,
  );

  await runBundleSchedule(ENV, h.deps, NOW);

  const row = h.rowsFor('s1')[0];
  // Clearing this before Shopify confirmed would strand the sale forever with
  // nothing left to restore from.
  expect(row.preSalePrice).toBe(310000);
  expect(row.scheduleError).toMatch(/Shopify said no/);
});

// Review Focus #3 — the campaign may be gone; the restore must not care.
it('restores a bundle whose campaign was deleted mid-sale', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 's1', operation: 'expand', parentVariantId: PARENT,
      price: 279000, preSalePrice: 310000, campaignId: null, status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('s1')],
    t,
  );

  await runBundleSchedule(ENV, h.deps, NOW);

  expect(t.setVariantPricing).toHaveBeenCalledWith(
    ENV, 's1.myshopify.com', PARENT,
    expect.objectContaining({ priceMinor: 310000 }),
  );
  expect(h.rowsFor('s1')[0].preSalePrice).toBeNull();
});

// Review Focus #4 — one unpriceable row must not abort the shop's sweep.
it('skips a bundle with no parent variant and records why, without aborting the pass', async () => {
  const t = pricingTransports();
  const h = harness(
    [
      bundleRow({
        id: 'bad', shopId: 's1', operation: 'expand', parentVariantId: null,
        price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
      }),
      bundleRow({
        id: 'good', shopId: 's1', operation: 'expand', parentVariantId: PARENT,
        price: 279000, status: 'Scheduled', scheduleStart: PAST, scheduleEnd: FUTURE,
      }),
    ],
    [shop('s1')],
    t,
  );

  await runBundleSchedule(ENV, h.deps, NOW);

  const bad = h.rowsFor('s1').find((r) => r.id === 'bad');
  const good = h.rowsFor('s1').find((r) => r.id === 'good');
  expect(bad?.scheduleError).toBeTruthy();
  expect(bad?.preSalePrice).toBeNull();
  // The second bundle still got processed — the first did not abort the pass.
  expect(good?.preSalePrice).toBe(310000);
});
```

If `harness` exposes the rows under a different name than `rowsFor`, use whatever it already provides; do not add a new accessor.

- [ ] **Step 5: Wire the cron**

In `src/lifecycle/bundleSchedule.ts`:

1. Extend `BundleTransports` with `readVariantPrice` and `setVariantPricing`, and add both to `createBundleScheduleDeps`'s `transports` object.
2. Inside the existing per-bundle `try`, after the operation-specific metafield work and **before** the status is persisted, compute the component sum from `repos.bundleItems.listForBundle(bundleId)`, call `decideSaleAction`, and act on it.
3. On `apply`: `readVariantPrice` first, then `setVariantPricing`, then persist `preSalePrice` **in the same `repos.bundles.update` call** as the status — so a crash cannot leave Shopify on sale with no captured price.
4. On `restore`: `setVariantPricing` with the captured price, and only on success persist `preSalePrice: null`.
5. On `none`: nothing.

A bundle with no `parentVariantId` records a `scheduleError` and continues; it must not throw, because one unpriceable bundle must not abort the rest of the shop's sweep.

- [ ] **Step 6: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/variantPricing.ts src/lib/variantPricing.test.ts src/lifecycle/bundleSchedule.ts src/lifecycle/bundleSchedule.test.ts
git commit -m "feat(bundles): apply and restore sale pricing in the schedule pass"
```

---

## Task 4: API — accept and return `compareAtPrice`

**Files:**
- Modify: `src/routes/bundles.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Produces: `BundleInput.compareAtPrice?: number` (major units, like `price`); `BundleDto.compareAtPrice?: MoneyV2`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('stores compareAtPrice in minor units and returns it as money', async () => {
    const repos = seed({ shops: [shopRow({ ...SHOP })] });

    const res = await app.request('/api/bundles', {
      method: 'POST',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Kit', operation: 'expand', price: 27.9, compareAtPrice: 31,
        parentVariantId: 'gid://shopify/ProductVariant/1',
        items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      }),
    }, env('development'));

    expect(res.status).toBe(201);
    expect(repos.bundles.rows[0]).toMatchObject({ compareAtPrice: 3100 });
    const json = (await res.json()) as { bundle: { compareAtPrice?: { amount: string } } };
    expect(json.bundle.compareAtPrice?.amount).toBe('31.00');
  });

  it('omits compareAtPrice when the merchant set none, rather than inventing one', async () => {
    seed({ bundles: [bundleRow({ compareAtPrice: null })] });

    const res = await app.request('/api/bundles', { headers: { 'x-shop-domain': 'mystore.myshopify.com' } }, env('development'));

    const json = (await res.json()) as { bundles: Array<Record<string, unknown>> };
    expect(json.bundles[0]).not.toHaveProperty('compareAtPrice');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api.integration.test.ts -t compareAtPrice`
Expected: FAIL — the field is neither stored nor returned.

- [ ] **Step 3: Implement**

Add the field to both shapes, mirroring exactly what `price` already does in this file:

```ts
// BundleInput
  compareAtPrice?: number; // dollars (major units), like `price`

// BundleDto
  compareAtPrice?: MoneyV2;

// on the way in, beside the existing `price` conversion:
  compareAtPrice: body.compareAtPrice === undefined
    ? null
    : toMinorUnits(body.compareAtPrice, currency),

// on the way out, in `toDto`, beside the existing `price` mapping:
  ...(row.compareAtPrice !== null
    ? { compareAtPrice: toMoney(row.compareAtPrice, currency)! }
    : {}),
```

Null stays **absent** from the DTO rather than becoming `0`: the component sum is the fallback and it is computed at write time, never stored, so a `0` here would read as "free" to every consumer.

- [ ] **Step 4: Verify and commit**

Run: `npm run type-check && npx vitest run`

```bash
git add src/routes/bundles.ts src/api.integration.test.ts
git commit -m "feat(bundles): accept and return compareAtPrice"
```

---

## Task 5: Let a bundle be edited during its own sale

**Files:**
- Modify: `src/routes/bundles.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `bundle.preSalePrice` (Task 1).

`assertExpandPriceBelowParent` compares the bundle's price against the parent's **live** price. During a sale the sale itself has lowered that price to equal the bundle's, so every save is rejected — the app refusing an edit because of its own sale. This is the 400 a merchant already hit for a different reason, and it must not come back by our own doing.

- [ ] **Step 1: Write the failing test**

```ts
  // Review Focus #5
  it('allows saving an expand bundle while its own sale has lowered the parent price', async () => {
    // On sale: parent now costs what the bundle costs, because we set it.
    seed({ bundles: [bundleRow({ id: 'b1', operation: 'expand', price: 2790, preSalePrice: 3100 })] });
    // The parent's LIVE price is the sale price, because the sale set it.
    // `variantNode`/the target-variant helper already in this file supply the
    // `nodes` payload `resolveVariants` reads.
    mockNodes([variantNode({ id: PARENT_GID, price: '27.90' })]);

    const res = await app.request('/api/bundles/b1', {
      method: 'PUT',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', price: 27.9 }),
    }, env('development'));

    expect(res.status).toBe(200);
  });

  it('still rejects a price at or above the parent when NOT on sale', async () => {
    seed({ bundles: [bundleRow({ id: 'b1', operation: 'expand', price: 2790, preSalePrice: null })] });
    mockNodes([variantNode({ id: PARENT_GID, price: '27.90' })]);

    const res = await app.request('/api/bundles/b1', {
      method: 'PUT',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({ price: 27.9 }),
    }, env('development'));

    expect(res.status).toBe(400);
  });
```

`mockNodes` and `PARENT_GID` stand for whatever this file already uses to queue an Admin `nodes` payload and name the target variant — see the `variantNode` helper around line 133 and the target-variant helper directly below it. Use those; do not add new ones.

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npx vitest run src/api.integration.test.ts -t "while its own sale"`
Expected: FAIL with 400.

- [ ] **Step 3: Implement**

When `preSalePrice !== null`, compare against `preSalePrice` rather than the live parent price — that is what the parent costs normally, and what it will cost again when the sale ends. Record the reason in a comment at the check.

- [ ] **Step 4: Verify and commit**

Run: `npm run type-check && npx vitest run`

```bash
git add src/routes/bundles.ts src/api.integration.test.ts
git commit -m "fix(bundles): compare against the pre-sale price while on sale"
```

---

## Task 6: Editor — compare-at field, and the price locked during a sale

**Note:** this repo has no frontend component tests, so this task carries component APIs, file paths and behaviour rather than test code. Its gates are `lint:ci`, `type-check` and the build, plus the manual check in Final verification.

**Files:**
- Modify: `web/bundles/api.ts`, `web/Pages/BundleEditor.tsx`

**Interfaces:**
- Consumes: `compareAtPrice` on the bundle DTO (Task 4); `isCampaignLocking` from `src/lib/campaignStatus`.

- [ ] **Step 1: Add the field to the client type**

`web/bundles/api.ts`: add `compareAtPrice?: MoneyV2` to the bundle type and `compareAtPrice?: number` to the save input, mirroring `price`.

- [ ] **Step 2: Add the compare-at input**

In the expand branch's price card, add a second money field labelled **"Compare-at price"**, prefilled with the component sum when the bundle has no stored value, with help text: *"What the components cost separately. Shown struck through on the product page."* Use `moneyPrefix`, like the price field.

- [ ] **Step 3: Lock price and compare-at while a campaign owns the bundle**

The editor already computes `scheduleLocked` from the owning campaign. Reuse that same value to set `disabled` on the price and compare-at fields, and add one `Banner` explaining that the campaign controls the price for its window — the same treatment the Schedule card already gets. Do not introduce a second notion of "locked"; one rule, one source.

- [ ] **Step 4: Verify**

Run: `npm run lint:ci && npm run type-check && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/bundles/api.ts web/Pages/BundleEditor.tsx
git commit -m "feat(bundles): compare-at field, and lock pricing during a campaign sale"
```

---

## Final verification

- [ ] **Run everything**

```bash
npm run type-check && npm run lint:ci && npx vitest run && npm run check
```

- [ ] **Confirm the sale round-trips in D1**

```bash
npx wrangler d1 execute cloudflare-shopify-starter-db --local \
  --command "SELECT name, price, compare_at_price, pre_sale_price, status FROM bundle;"
```

Expected: `pre_sale_price` is non-null **only** for bundles inside a live campaign window, and null for every other row. A non-null `pre_sale_price` on a bundle whose window has closed means a restore failed and is pending retry — which is the designed state, not a bug, but worth seeing.

- [ ] **Manual check against the real store**

This is the part no test covers, and the only way to know the Admin write is shaped right. With `npm run dev`: put a bundle in a campaign with a window starting a few minutes out, publish, then run `npm run cron` after the start time. Confirm in Shopify admin that the parent variant shows the sale price with the component sum struck through, then let the window end, run the cron again, and confirm the original price is back and `pre_sale_price` is null.

If the app cannot be started here, say so plainly rather than claiming it was checked.
