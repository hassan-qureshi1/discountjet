# E8 Campaigns — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant builds a campaign in a four-step wizard — Discounts → Bundles → Schedule → Summary — and publishes it, which creates the discounts in Shopify and puts every member on the campaign's single window.

**Architecture:** A campaign has no runtime behaviour. Publishing stamps the campaign's window onto its members: discounts get it as their own Shopify `startsAt`/`endsAt` and Shopify activates them natively; bundles get it as `scheduleStart`/`scheduleEnd` and the existing cron activates them. Both carry the same two timestamps, so they fire together by construction. The campaign's own status and its ownership lock are derived, never swept.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Vitest, React 18 + Shopify Polaris 13, Shopify Admin GraphQL `2026-04`.

**Spec:** `docs/superpowers/specs/2026-09-27-e08-campaigns-design.md`

## Global Constraints

- All IDs are `crypto.randomUUID()`. Timestamps are ISO 8601 strings stored as `text()`. Booleans are `integer` `0/1`.
- Every new table carries a non-null `shopId` FK to `shopify_shop` with `onDelete: 'cascade'` and gets a repository extending `ShopScopedRepository`. (`webhook_event` and `template` are the only documented exceptions, per `CLAUDE.md:33`; nothing here adds a third.)
- All D1 access goes through a repository — no `createDb()` or Drizzle query builder outside `src/db/repositories/`. Route handlers use `c.get('repos')`.
- Return `null`, never `undefined`, for a miss.
- `docs/erd.dbml` is updated in the SAME commit as the `schema.ts` edit and the generated migration.
- All `/api/*` routes sit behind `requireShop`. Do not touch `PUBLIC_API_PATHS`.
- Fail loudly: no `?? ''` or default masking a missing token, domain, function id or config.
- Schedule values are normalized UTC ISO-8601 via `normalizeUtc`; ordering enforced by `assertWindowOrder`. Both from `src/lib/scheduleWindow.ts`.
- The metafield wire format is fixed: namespaces `$app:discount-{tier,bundle,special}`, key `config`, 10 KB cap, `rule_type` values `tier-discount`, `bundle-discount`, `special_discount` (the last uses an underscore).
- Frontend uses Polaris components; every async UI shows a spinner on load and a Polaris `Banner` on error.

## Review Focus

Five failure modes the spec implies but does not itself test. Each has a test assigned to the task that owns the code.

1. **Publishing the same campaign twice** (a double-click, a retried request). The second must 409 without creating a second set of Shopify discounts — duplicates are live promotions nobody asked for. (Task 6)
2. **An `immediate` campaign has a null `startsAt`**, but Shopify requires one on create. It must be stamped with "now" at publish, not passed through as null. (Task 6)
3. **A window entirely in the past.** `deriveStatus` returns `Ended`; the discounts would be created already expired. Publish must reject it rather than create dead discounts. (Task 6)
4. **A bundle already owned by a live campaign** being added to a second one. Two campaigns would author the same `scheduleStart`/`scheduleEnd` and the last publish would silently win. (Task 5)
5. **Partial publish failure leaves created discounts behind.** The campaign must still publish, failed rows must carry their error, and a re-publish must not duplicate the ones that succeeded. (Task 6)

---

## File Structure

**Create:**
- `src/lib/createDiscount.ts` (+ test) — the shared create-in-Shopify service both the route and publish call.
- `src/lib/campaignStatus.ts` (+ test) — status and lock derivation. Pure.
- `src/db/repositories/CampaignRepository.ts`, `CampaignDiscountRepository.ts`, `CampaignBundleRepository.ts` (+ tests).
- `src/routes/campaigns.ts` — CRUD, publish, clone.
- `web/campaigns/api.ts`, `web/campaigns/hooks.ts`
- `web/Pages/Campaigns.tsx`, `web/Pages/CampaignBuilder.tsx`, `web/Pages/CampaignDetail.tsx`

**Modify:**
- `src/routes/discounts.ts` — delegate to `createDiscount.ts`.
- `src/db/schema.ts`, `docs/erd.dbml`, `drizzle/migrations/` — three tables + `bundle.campaignId`.
- `src/db/repositories/index.ts`, `inMemory.ts` — register the three.
- `src/index.ts` — mount `campaignRoutes`.
- `web/App.tsx` — three routes + nav link.
- `web/Pages/BundleEditor.tsx` — lock the Schedule card while a live campaign owns the bundle.

**Note on Tasks 8–10:** these are UI and, like the E5 plan's UI tasks, carry component APIs, file paths and behaviour rather than every line. The patterns are in `web/Pages/Bundles.tsx`, `web/Pages/TemplateCreate.tsx` and `web/templates/hooks.ts`.

---

## Task 1: Extract the create-discount service

**Files:**
- Create: `src/lib/createDiscount.ts`, `src/lib/createDiscount.test.ts`
- Modify: `src/routes/discounts.ts`

**Interfaces:**
- Consumes: `getAdapter`, `DiscountEngineType` from `../lib/discountEngines/adapters`; `resolveDiscountFunctionId` from `../lib/discountFunctions`; `adminGraphql` from `../lib/graphqlAdmin`.
- Produces:
  - `interface CreateDiscountRequest { engineType: DiscountEngineType; form: unknown; method: 'automatic' | 'code'; title?: string; code?: string; startsAt: string; endsAt?: string; combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean } }`
  - `type CreateDiscountOutcome = { ok: true; discountId: string; value: string; sizeBytes: number } | { ok: false; status: 400 | 502; error: string }`
  - `createDiscountInShopify(env: Env, shopDomain: string, req: CreateDiscountRequest): Promise<CreateDiscountOutcome>`

**Why first:** publish must run the *same* create logic as the route. A second copy would drift, and the thing that drifts is what lands on a shopper's bill.

**Why an outcome object rather than throws:** the route maps it to a status code; publish records it per row and carries on. A thrown error would force publish to catch-and-classify, which is the same decision made twice.

- [ ] **Step 1: Write the failing test**

Create `src/lib/createDiscount.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { createDiscountInShopify } from './createDiscount';
import type { Env } from '../types/env';

const ENV = {} as Env;
const SHOP = 'test.myshopify.com';

const TIER_FORM = {
  message: '', applyTo: 'price', discountType: 'percentage',
  productDiscountSelectionStrategy: 'MAXIMUM', platform: 'BOTH',
  tiers: [{
    id: 't1', value: '20', selectorType: 'variant_id',
    targets: JSON.stringify([{ variantId: '123' }]), min_qty: '3',
  }],
};

function mockFunctionsThenCreate(payloadKey: 'discountAutomaticAppCreate' | 'discountCodeAppCreate') {
  const created = payloadKey === 'discountCodeAppCreate'
    ? { codeAppDiscount: { discountId: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] }
    : { automaticAppDiscount: { discountId: 'gid://shopify/DiscountAutomaticNode/1' }, userErrors: [] };
  vi.mocked(adminGraphql)
    .mockResolvedValueOnce({
      data: { shopifyFunctions: { nodes: [
        { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
      ] } },
    } as never)
    .mockResolvedValueOnce({ data: { [payloadKey]: created } } as never);
}

describe('createDiscountInShopify', () => {
  beforeEach(() => vi.mocked(adminGraphql).mockReset());

  it('creates an automatic discount and returns its id and serialized config', async () => {
    mockFunctionsThenCreate('discountAutomaticAppCreate');

    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'automatic',
      title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: true, discountId: 'gid://shopify/DiscountAutomaticNode/1' });
    if (!out.ok) throw new Error('expected ok');
    expect(JSON.parse(out.value).rule_type).toBe('tier-discount');
    expect(out.sizeBytes).toBeGreaterThan(0);

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.functionId).toBe('gid://shopify/Function/tier');
    expect(input.discountClasses).toEqual(['PRODUCT']);
    expect(input.startsAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('titles a code discount with its code', async () => {
    mockFunctionsThenCreate('discountCodeAppCreate');

    await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'code',
      title: 'ignored', code: 'SPRING20', startsAt: '2026-10-01T00:00:00.000Z',
    });

    const [, , query, variables] = vi.mocked(adminGraphql).mock.calls[1];
    expect(String(query)).toContain('discountCodeAppCreate');
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.title).toBe('SPRING20');
    expect(input.code).toBe('SPRING20');
    expect(input.discountClasses).toEqual(['PRODUCT']);
  });

  it('returns a 400 outcome for an invalid form, without calling Shopify', async () => {
    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: { ...TIER_FORM, tiers: [] }, method: 'automatic',
      title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns a 400 outcome for a config with no usable rules', async () => {
    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', method: 'automatic', title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
      // `product_id` selector with items carrying only a variantId: validate
      // passes, the builder resolves no ids, the config comes out empty.
      form: { ...TIER_FORM, tiers: [{
        id: 't1', value: '20', selectorType: 'product_id',
        targets: JSON.stringify([{ variantId: '123' }]), min_qty: '',
      }] },
    });

    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('returns a 502 outcome when the function is not deployed', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({
      data: { shopifyFunctions: { nodes: [] } },
    } as never);

    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'automatic',
      title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: false, status: 502 });
  });

  it('returns a 502 outcome carrying Shopify userErrors', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'V', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountAutomaticAppCreate: { automaticAppDiscount: null, userErrors: [{ field: ['title'], message: 'Title is invalid' }] } },
      } as never);

    const out = await createDiscountInShopify(ENV, SHOP, {
      engineType: 'tier', form: TIER_FORM, method: 'automatic',
      title: 'x', startsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(out).toMatchObject({ ok: false, status: 502 });
    if (out.ok) throw new Error('expected failure');
    expect(out.error).toContain('Title is invalid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/createDiscount.test.ts`
Expected: FAIL — "Failed to resolve import './createDiscount'".

- [ ] **Step 3: Move the logic out of the route**

Create `src/lib/createDiscount.ts` by moving — not retyping — the body of the current `POST /api/discounts` handler from the `getAdapter(...)` line through the mutation and its error handling. Read `src/routes/discounts.ts` and carry the code and its comments across verbatim; those comments record the two Shopify behaviours that cost a day to find (`discountClasses` on both mutations, `isActionable` catching an empty config), and retyping them from memory loses that.

The shape:

```ts
export interface CreateDiscountRequest {
  engineType: DiscountEngineType;
  form: unknown;
  method: 'automatic' | 'code';
  /** Used when `method` is 'automatic'. A code discount is titled by its code. */
  title?: string;
  /** Required when `method` is 'code'. */
  code?: string;
  startsAt: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
}

export type CreateDiscountOutcome =
  | { ok: true; discountId: string; value: string; sizeBytes: number }
  | { ok: false; status: 400 | 502; error: string };

/**
 * Create one discount in Shopify from a form, and return the outcome.
 *
 * Shared by `POST /api/discounts` and campaign publish, so both run identical
 * validation, serialisation and mutation logic. A second copy would drift, and
 * what drifts here is the configuration a Rust function reads to price a cart.
 *
 * Returns an outcome rather than throwing: the route maps it to a status, while
 * publish records it against one row and carries on to the next discount.
 */
export async function createDiscountInShopify(
  env: Env,
  shopDomain: string,
  req: CreateDiscountRequest,
): Promise<CreateDiscountOutcome> { /* moved body */ }
```

The title rule moves too: `const title = req.method === 'code' ? req.code!.trim() : req.title!.trim()`.

- [ ] **Step 4: Make the route delegate**

`POST /api/discounts` keeps its own request-shape guards (slug, startsAt, method, code-required, title-required-for-automatic, form-is-an-object) and its template lookup, then calls the service and maps the outcome:

```ts
  const outcome = await createDiscountInShopify(c.env, shopDomain, {
    engineType: template.type,
    form: body.form,
    method,
    title: body.title,
    code: body.code,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    combinesWith: body.combinesWith,
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ discountId: outcome.discountId });
```

- [ ] **Step 5: Run the whole suite**

Run: `npm run type-check && npx vitest run`
Expected: PASS, including every existing `POST /api/discounts` test unchanged. Those tests are the proof this refactor changed no behaviour — if one needs editing, stop and work out why rather than adjusting it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/createDiscount.ts src/lib/createDiscount.test.ts src/routes/discounts.ts
git commit -m "refactor(discounts): extract the create-in-Shopify service"
```

---

## Task 2: The campaign tables

**Files:**
- Modify: `src/db/schema.ts`, `docs/erd.dbml`
- Create: `drizzle/migrations/00NN_*.sql` (generated)

**Interfaces:**
- Produces: the `campaign`, `campaignDiscount`, `campaignBundle` tables and `bundle.campaignId`.

- [ ] **Step 1: Add the tables**

Append to `src/db/schema.ts`:

```ts
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

    configJson: text('config_json').notNull(),
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
```

- [ ] **Step 2: Add `campaignId` to `bundle`**

In the `bundle` table, after `blockOnFailure`:

```ts
    // Set at publish when a campaign takes over this bundle's schedule.
    // `set null`, NOT cascade: deleting a campaign must free its bundles, not
    // delete them — the bundle is the merchant's, the schedule was the
    // campaign's. The LOCK is derived from the owning campaign's status rather
    // than from this column being set (see src/lib/campaignStatus.ts), so an
    // ended campaign's bundles unlock with nothing having to clear this.
    campaignId: text('campaign_id').references(() => campaign.id, { onDelete: 'set null' }),
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npm run d1:generate && npm run d1:migrate:local`
Expected: three `CREATE TABLE`s, the indexes, and an `ALTER TABLE bundle ADD campaign_id`. Read the generated SQL; if it contains `DROP TABLE` (a SQLite table rebuild), stop and report rather than commit it.

- [ ] **Step 4: Mirror all four changes in the ERD**

Add the three tables to `docs/erd.dbml` following the file's existing style, including the `ref`s to `shopify_shop` and `campaign` with their `ON DELETE` behaviour noted, the named indexes inside `indexes { }`, and the enum values in column `note`s. Add `campaign_id` to the existing `bundle` table with a note saying `ON DELETE SET NULL`.

- [ ] **Step 5: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS. If a fixture builds a `BundleRow` literal and no longer compiles, add `campaignId: null` to it.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts docs/erd.dbml drizzle/migrations src/api.integration.test.ts src/db/repositories/inMemory.ts
git commit -m "feat(campaigns): add the campaign tables and the bundle ownership column"
```

---

## Task 3: Status and lock derivation

**Files:**
- Create: `src/lib/campaignStatus.ts`, `src/lib/campaignStatus.test.ts`

**Interfaces:**
- Consumes: `deriveStatus` from `./scheduleWindow`.
- Produces:
  - `type CampaignStatus = 'Draft' | 'Scheduled' | 'Published' | 'Ended'`
  - `deriveCampaignStatus(stored: CampaignStatus, startsAt: string | null, endsAt: string | null, now: string): CampaignStatus`
  - `isCampaignLocking(status: CampaignStatus): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/campaignStatus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveCampaignStatus, isCampaignLocking } from './campaignStatus';

const NOW = '2026-10-03T12:00:00.000Z';
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

describe('deriveCampaignStatus', () => {
  it('leaves a Draft alone whatever its window says', () => {
    expect(deriveCampaignStatus('Draft', PAST, FUTURE, NOW)).toBe('Draft');
    expect(deriveCampaignStatus('Draft', null, null, NOW)).toBe('Draft');
  });

  // `immediate` stores a null startsAt, which means "live from publish".
  it('reads a published campaign with no window as Published', () => {
    expect(deriveCampaignStatus('Published', null, null, NOW)).toBe('Published');
  });

  it('reads a future window as Scheduled', () => {
    expect(deriveCampaignStatus('Scheduled', FUTURE, null, NOW)).toBe('Scheduled');
  });

  it('reads an open window as Published — the prototype’s word for Active', () => {
    expect(deriveCampaignStatus('Scheduled', PAST, FUTURE, NOW)).toBe('Published');
  });

  it('reads a closed window as Ended', () => {
    expect(deriveCampaignStatus('Published', PAST, PAST, NOW)).toBe('Ended');
  });

  it('is boundary-exact, matching deriveStatus', () => {
    expect(deriveCampaignStatus('Scheduled', NOW, FUTURE, NOW)).toBe('Published');
    expect(deriveCampaignStatus('Published', PAST, NOW, NOW)).toBe('Ended');
  });
});

describe('isCampaignLocking', () => {
  // The lock is derived from the OWNING campaign's status, not from a column
  // being set: nothing runs when a window closes, so nothing would clear it.
  it('locks while scheduled or published, releases once ended', () => {
    expect(isCampaignLocking('Scheduled')).toBe(true);
    expect(isCampaignLocking('Published')).toBe(true);
    expect(isCampaignLocking('Ended')).toBe(false);
  });

  it('does not lock from a draft — nothing has been published yet', () => {
    expect(isCampaignLocking('Draft')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/campaignStatus.test.ts`
Expected: FAIL — cannot resolve `./campaignStatus`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/campaignStatus.ts`:

```ts
import { deriveStatus } from './scheduleWindow';

export type CampaignStatus = 'Draft' | 'Scheduled' | 'Published' | 'Ended';

/**
 * What a campaign's status is right now.
 *
 * `Draft` is the merchant's state and is never derived over — an unpublished
 * campaign has no window in force whatever dates it carries. Everything after
 * publish is a function of the window, so there is nothing to write and nothing
 * to go stale.
 *
 * Reuses `deriveStatus`, reading its `Active` as `Published` to match the
 * prototype's vocabulary. Same concept, and deliberately the same code — a
 * campaign and its bundles must agree about what a window means, and the surest
 * way is for both to ask the same function.
 */
export function deriveCampaignStatus(
  stored: CampaignStatus,
  startsAt: string | null,
  endsAt: string | null,
  now: string,
): CampaignStatus {
  if (stored === 'Draft') return 'Draft';
  const derived = deriveStatus(startsAt, endsAt, now);
  return derived === 'Active' ? 'Published' : derived;
}

/**
 * Whether a campaign in this status owns its members.
 *
 * Derived rather than stored, because nothing runs when a window closes: an
 * ended campaign's bundles and discounts free themselves the moment the window
 * passes, with no sweep to write and nothing to be left behind.
 */
export function isCampaignLocking(status: CampaignStatus): boolean {
  return status === 'Scheduled' || status === 'Published';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/campaignStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaignStatus.ts src/lib/campaignStatus.test.ts
git commit -m "feat(campaigns): derive campaign status and the ownership lock"
```

---

## Task 4: The three repositories

**Files:**
- Create: `src/db/repositories/CampaignRepository.ts`, `CampaignDiscountRepository.ts`, `CampaignBundleRepository.ts`, and `CampaignRepository.test.ts`
- Modify: `src/db/repositories/index.ts`, `src/db/repositories/inMemory.ts`

**Interfaces:**
- Consumes: the three tables (Task 2); `ShopScopedRepository`, `Db` from the existing repository layer.
- Produces:
  - `CampaignRow`, `CampaignNew`, `ICampaignRepository` with `listByStatus(status?: CampaignStatus): Promise<CampaignRow[]>`
  - `CampaignDiscountRow`, `ICampaignDiscountRepository` with `listForCampaign(campaignId: string)`, `setPublishResult(id, { shopifyGid, publishState, publishError })`
  - `CampaignBundleRow`, `ICampaignBundleRepository` with `listForCampaign(campaignId: string)`, `deleteForCampaign(campaignId: string)`
  - `campaigns`, `campaignDiscounts`, `campaignBundles` on `Repositories`, and in-memory fakes with matching names

Each extends `ShopScopedRepository`, so `shop_id = ?` is welded onto every read and write. Follow `src/db/repositories/BundleRepository.ts` for the shape, and register all three in `index.ts` (`Repositories` + `createRepositoriesFromDb`) and in `inMemory.ts` (`createInMemoryRepositories` seed keys `campaigns`, `campaignDiscounts`, `campaignBundles`).

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/CampaignRepository.test.ts`, following the SQL-asserting pattern in `ShopScopedRepository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { CampaignRepository } from './CampaignRepository';
import { CampaignBundleRepository } from './CampaignBundleRepository';
import { createFakeD1 } from './testing/fakeD1';

const SHOP = 'shop-a';

function repos(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  const db = createDb(fake.db);
  return {
    fake,
    campaigns: new CampaignRepository(db, SHOP),
    campaignBundles: new CampaignBundleRepository(db, SHOP),
  };
}

describe('CampaignRepository', () => {
  it('scopes a status listing by shop as well as status', async () => {
    const { fake, campaigns } = repos();
    await campaigns.listByStatus('Draft');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('Draft');
  });

  it('scopes an unfiltered listing by shop', async () => {
    const { fake, campaigns } = repos();
    await campaigns.listByStatus();

    expect(fake.lastQuery().sql).toMatch(/"shop_id" = \?/i);
    expect(fake.lastQuery().params).toEqual([SHOP]);
  });

  it('scopes findById by shop, so another shop’s campaign reads as absent', async () => {
    const { fake, campaigns } = repos();
    await campaigns.findById('c1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
  });

  it('returns null, never undefined, for a miss', async () => {
    const { campaigns } = repos([]);
    await expect(campaigns.findById('nope')).resolves.toBeNull();
  });
});

describe('CampaignBundleRepository', () => {
  it('scopes a campaign’s bundles by shop as well as campaign', async () => {
    const { fake, campaignBundles } = repos();
    await campaignBundles.listForCampaign('c1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"campaign_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('c1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/CampaignRepository.test.ts`
Expected: FAIL — cannot resolve the new modules.

- [ ] **Step 3: Write the three repositories**

`CampaignRepository.ts`, matching `BundleRepository.ts`'s shape:

```ts
import { and, desc, eq } from 'drizzle-orm';
import { campaign } from '../schema';
import { ShopScopedRepository } from './ShopScopedRepository';
import type { Db } from './BaseRepository';
import type { IShopScopedRepository } from './types';

export type CampaignRow = typeof campaign.$inferSelect;
export type CampaignNew = Omit<typeof campaign.$inferInsert, 'shopId'>;

export interface ICampaignRepository extends IShopScopedRepository<CampaignRow, CampaignNew> {
  listByStatus(status?: CampaignRow['status']): Promise<CampaignRow[]>;
}

export class CampaignRepository
  extends ShopScopedRepository<typeof campaign>
  implements ICampaignRepository {
  constructor(db: Db, shopId: string) { super(db, campaign, shopId); }

  /** Newest first — the list page's default order, and what a merchant expects
   *  when they have just created one. */
  async listByStatus(status?: CampaignRow['status']): Promise<CampaignRow[]> {
    const where = status ? this.scope(eq(campaign.status, status)) : this.scope();
    return this.db.select().from(campaign).where(where).orderBy(desc(campaign.createdAt)).all();
  }
}
```

Write `CampaignDiscountRepository` and `CampaignBundleRepository` the same way. Compose every custom predicate through `this.scope(...)` — that is what keeps them scoped. Its argument is optional, so `this.scope()` is the unfiltered scoped read; never hand-write `eq(table.shopId, this.shopId)` at a call site. `setPublishResult` is a narrow update of the three publish columns together, in the spirit of `BundleRepository.setMetafieldState`, because they are meaningless apart.

- [ ] **Step 4: Register them**

In `index.ts`: import, re-export the classes and types, add `campaigns`, `campaignDiscounts`, `campaignBundles` to `Repositories`, and construct them in `createRepositoriesFromDb`. In `inMemory.ts`: add the three fakes and their seed keys, mirroring the real scoping (`inScope` on `shopId`) and the `campaign_id` filters.

- [ ] **Step 5: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories
git commit -m "feat(campaigns): add the campaign repositories"
```

---

## Task 5: Campaign CRUD routes

**Files:**
- Create: `src/routes/campaigns.ts`
- Modify: `src/index.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `c.get('repos').campaigns|campaignDiscounts|campaignBundles`; `deriveCampaignStatus`, `isCampaignLocking` (Task 3); `normalizeUtc`, `assertWindowOrder` from `../lib/scheduleWindow`.
- Produces: `campaignRoutes`; `GET/POST /api/campaigns`, `GET/PUT/DELETE /api/campaigns/:id`.

A `CampaignDto` carries the campaign, its derived status, its discounts and its bundle ids. Every read recomputes the status with `deriveCampaignStatus(row.status, row.startsAt, row.endsAt, new Date().toISOString())` and returns the derived value; when it differs from the stored one, write it back so the list's status filter stays useful.

- [ ] **Step 1: Write the failing tests**

Append to `src/api.integration.test.ts` a `describe('Campaign API')`, using the file's `seed({ campaigns: [...] })` / `app.request(path, init, env('development'))` idiom, with a `campaignRow` helper typed `(over: Partial<CampaignRow> = {}): CampaignRow`:

```ts
  it('GET /api/campaigns returns campaigns with a DERIVED status', async () => {
    // Stored as Scheduled, but its window opened in the past.
    seed({ campaigns: [campaignRow({
      status: 'Scheduled',
      scheduleMode: 'window',
      startsAt: '2020-01-01T00:00:00.000Z',
      endsAt: '2099-01-01T00:00:00.000Z',
    })] });

    const res = await app.request('/api/campaigns', { headers: { 'x-shop-domain': 'mystore.myshopify.com' } }, env('development'));

    const json = (await res.json()) as { campaigns: Array<{ status: string }> };
    expect(json.campaigns[0].status).toBe('Published');
  });

  it('PUT /api/campaigns/:id 409s a published campaign', async () => {
    seed({ campaigns: [campaignRow({ id: 'c1', status: 'Published', scheduleMode: 'immediate' })] });

    const res = await app.request('/api/campaigns/c1', {
      method: 'PUT',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    }, env('development'));

    expect(res.status).toBe(409);
  });

  it('DELETE /api/campaigns/:id 409s a published campaign', async () => {
    seed({ campaigns: [campaignRow({ id: 'c1', status: 'Published', scheduleMode: 'immediate' })] });

    const res = await app.request('/api/campaigns/c1', {
      method: 'DELETE', headers: { 'x-shop-domain': 'mystore.myshopify.com' },
    }, env('development'));

    expect(res.status).toBe(409);
  });

  // Review Focus #4 — two campaigns authoring one bundle's window means the
  // last publish silently wins.
  it('PUT /api/campaigns/:id refuses a bundle a live campaign already owns', async () => {
    seed({
      campaigns: [
        campaignRow({ id: 'live', status: 'Published', scheduleMode: 'immediate' }),
        campaignRow({ id: 'draft', status: 'Draft', scheduleMode: 'immediate' }),
      ],
      bundles: [bundleRow({ id: 'b1', campaignId: 'live' })],
      campaignBundles: [{
        id: 'cb1', shopId: SHOP.id, campaignId: 'live', bundleId: 'b1',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    const res = await app.request('/api/campaigns/draft', {
      method: 'PUT',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleIds: ['b1'] }),
    }, env('development'));

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/campaign/i);
  });

  it('PUT allows a bundle whose owning campaign has ENDED', async () => {
    seed({
      campaigns: [
        campaignRow({ id: 'old', status: 'Published', scheduleMode: 'window',
          startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2020-02-01T00:00:00.000Z' }),
        campaignRow({ id: 'draft', status: 'Draft', scheduleMode: 'immediate' }),
      ],
      bundles: [bundleRow({ id: 'b1', campaignId: 'old' })],
    });

    const res = await app.request('/api/campaigns/draft', {
      method: 'PUT',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleIds: ['b1'] }),
    }, env('development'));

    expect(res.status).toBe(200);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api.integration.test.ts -t "Campaign API"`
Expected: FAIL — the routes do not exist.

- [ ] **Step 3: Write the routes**

Create `src/routes/campaigns.ts` with `GET /api/campaigns` (optional `?status=`), `POST /api/campaigns` (creates a `Draft`; `name` required), `GET /api/campaigns/:id` (404 when absent), `PUT /api/campaigns/:id` and `DELETE /api/campaigns/:id` (both 409 unless the derived status is `Draft`).

`PUT` accepts `name`, `description`, `scheduleMode`, `startsAt`, `endsAt`, `discounts` and `bundleIds`. Normalize the window with `normalizeUtc` and order it with `assertWindowOrder`, both producing a 400 on failure, exactly as `resolveSchedule` does in `src/routes/bundles.ts`.

For `bundleIds`, before writing: load each bundle, and if it carries a `campaignId` whose campaign `isCampaignLocking(deriveCampaignStatus(...))`, return 409 naming the owning campaign. A bundle whose owner has ended is free — that is the derived lock doing its job.

- [ ] **Step 4: Mount the routes**

In `src/index.ts`, import `campaignRoutes` and `app.route('/', campaignRoutes)` alongside the others, before the catch-all SPA route.

- [ ] **Step 5: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/campaigns.ts src/index.ts src/api.integration.test.ts
git commit -m "feat(campaigns): campaign CRUD with derived status and the bundle lock"
```

---

## Task 6: Publish

**Files:**
- Modify: `src/routes/campaigns.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `createDiscountInShopify` (Task 1); the repositories (Task 4); `deriveCampaignStatus` (Task 3); `requireShopDomain`.
- Produces: `POST /api/campaigns/:id/publish` returning `{ status, created, failed }`.

- [ ] **Step 1: Write the failing tests**

Append to the `Campaign API` describe. `adminGraphql` is already mocked in this file:

```ts
  it('creates each discount with the CAMPAIGN’s window and stamps every bundle', async () => {
    const repos = seed({
      campaigns: [campaignRow({ id: 'c1', status: 'Draft', scheduleMode: 'window',
        startsAt: '2099-01-01T00:00:00.000Z', endsAt: '2099-02-01T00:00:00.000Z' })],
      campaignDiscounts: [campaignDiscountRow({ id: 'cd1', campaignId: 'c1' })],
      bundles: [bundleRow({ id: 'b1' })],
      campaignBundles: [campaignBundleRow({ id: 'cb1', campaignId: 'c1', bundleId: 'b1' })],
    });
    mockFunctionsThenCreate();

    const res = await publish('c1');

    expect(res.status).toBe(200);
    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    // The whole design in one assertion: the discount carries the CAMPAIGN's window.
    expect(input.startsAt).toBe('2099-01-01T00:00:00.000Z');
    expect(input.endsAt).toBe('2099-02-01T00:00:00.000Z');
    // And the bundle carries the same two timestamps, so they fire together.
    expect(repos.bundles.rows[0]).toMatchObject({
      scheduleStart: '2099-01-01T00:00:00.000Z',
      scheduleEnd: '2099-02-01T00:00:00.000Z',
      campaignId: 'c1',
    });
  });

  // Review Focus #2
  it('stamps an immediate campaign with now, since Shopify requires a startsAt', async () => {
    seed({
      campaigns: [campaignRow({ id: 'c1', status: 'Draft', scheduleMode: 'immediate', startsAt: null, endsAt: null })],
      campaignDiscounts: [campaignDiscountRow({ id: 'cd1', campaignId: 'c1' })],
    });
    mockFunctionsThenCreate();

    await publish('c1');

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(typeof input.startsAt).toBe('string');
    expect(input.startsAt).not.toBeNull();
    expect(input.endsAt).toBeUndefined();
  });

  // Review Focus #1
  it('409s a second publish, without creating a second set of discounts', async () => {
    seed({
      campaigns: [campaignRow({ id: 'c1', status: 'Published', scheduleMode: 'immediate' })],
      campaignDiscounts: [campaignDiscountRow({ id: 'cd1', campaignId: 'c1', publishState: 'created' })],
    });

    const res = await publish('c1');

    expect(res.status).toBe(409);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review Focus #3
  it('400s a window entirely in the past rather than creating expired discounts', async () => {
    seed({
      campaigns: [campaignRow({ id: 'c1', status: 'Draft', scheduleMode: 'window',
        startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2020-02-01T00:00:00.000Z' })],
      campaignDiscounts: [campaignDiscountRow({ id: 'cd1', campaignId: 'c1' })],
    });

    const res = await publish('c1');

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('400s an empty campaign', async () => {
    seed({ campaigns: [campaignRow({ id: 'c1', status: 'Draft', scheduleMode: 'immediate' })] });

    const res = await publish('c1');

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review Focus #5
  it('records a failed discount and still publishes the rest', async () => {
    const repos = seed({
      campaigns: [campaignRow({ id: 'c1', status: 'Draft', scheduleMode: 'immediate' })],
      campaignDiscounts: [
        campaignDiscountRow({ id: 'cd1', campaignId: 'c1' }),
        campaignDiscountRow({ id: 'cd2', campaignId: 'c1' }),
      ],
    });
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { shopifyFunctions: { nodes: [
        { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'V', apiType: 'discount' },
      ] } } } as never)
      .mockResolvedValueOnce({ data: { discountAutomaticAppCreate: {
        automaticAppDiscount: null, userErrors: [{ field: ['title'], message: 'Title is invalid' }],
      } } } as never)
      .mockResolvedValueOnce({ data: { shopifyFunctions: { nodes: [
        { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'V', apiType: 'discount' },
      ] } } } as never)
      .mockResolvedValueOnce({ data: { discountAutomaticAppCreate: {
        automaticAppDiscount: { discountId: 'gid://shopify/DiscountAutomaticNode/2' }, userErrors: [],
      } } } as never);

    const res = await publish('c1');

    expect(res.status).toBe(200);
    const states = repos.campaignDiscounts.rows.map((r) => r.publishState).sort();
    expect(states).toEqual(['created', 'failed']);
    const failed = repos.campaignDiscounts.rows.find((r) => r.publishState === 'failed');
    expect(failed?.publishError).toContain('Title is invalid');
    // Published despite the failure — the created one exists in Shopify and
    // deleting it to "undo" would be destructive and unasked-for.
    expect(repos.campaigns.rows[0].status).not.toBe('Draft');
  });
```

Add the `publish(id)` helper and the `campaignDiscountRow` / `campaignBundleRow` fixtures beside the existing typed helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api.integration.test.ts -t "Campaign API"`
Expected: FAIL — the publish route does not exist.

- [ ] **Step 3: Write the publish route**

Add to `src/routes/campaigns.ts`:

```ts
campaignRoutes.post('/api/campaigns/:id/publish', async (c) => {
  const repos = c.get('repos');
  const id = c.req.param('id');
  const now = new Date().toISOString();

  const row = await repos.campaigns.findById(id);
  if (!row) return c.json({ error: 'Campaign not found' }, 404);

  // Publishing twice would create a second set of live discounts. The status is
  // derived, so a campaign whose window has simply passed is `Ended` and is
  // refused here too — republishing is what cloning is for.
  const status = deriveCampaignStatus(row.status, row.startsAt, row.endsAt, now);
  if (status !== 'Draft') {
    return c.json({ error: `A ${status.toLowerCase()} campaign cannot be published again. Clone it to make changes.` }, 409);
  }

  const discounts = await repos.campaignDiscounts.listForCampaign(id);
  const bundles = await repos.campaignBundles.listForCampaign(id);
  if (discounts.length === 0 && bundles.length === 0) {
    return c.json({ error: 'Add at least one discount or bundle before publishing.' }, 400);
  }

  // `immediate` stores no window; Shopify requires a startsAt, so publish is
  // the moment it begins.
  const startsAt = row.scheduleMode === 'immediate' ? now : row.startsAt;
  if (!startsAt) return c.json({ error: 'A scheduled campaign needs a start date.' }, 400);
  const endsAt = row.scheduleMode === 'immediate' ? null : row.endsAt;

  // A window already closed would create discounts Shopify expires immediately
  // — live-looking rows that can never fire.
  if (endsAt && endsAt <= now) {
    return c.json({ error: 'This campaign’s window has already closed. Change the dates before publishing.' }, 400);
  }

  const shopDomain = requireShopDomain(c);
  let created = 0;
  let failed = 0;

  for (const cd of discounts) {
    // Sequential on purpose: each create is its own Admin call and a failure
    // must not abandon the rest.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await createDiscountInShopify(c.env, shopDomain, {
      engineType: cd.type,
      form: JSON.parse(cd.configJson),
      method: cd.method,
      title: cd.name,
      code: cd.code ?? undefined,
      startsAt,
      ...(endsAt ? { endsAt } : {}),
    });

    if (outcome.ok) {
      created += 1;
      // eslint-disable-next-line no-await-in-loop
      await repos.campaignDiscounts.setPublishResult(cd.id, {
        shopifyGid: outcome.discountId, publishState: 'created', publishError: null,
      });
    } else {
      failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await repos.campaignDiscounts.setPublishResult(cd.id, {
        shopifyGid: null, publishState: 'failed', publishError: outcome.error,
      });
    }
  }

  // Bundles are not written to Shopify here. Stamping the window and the owner
  // is the whole job: the existing cron activates them on the boundary exactly
  // as it does a merchant-scheduled bundle.
  for (const cb of bundles) {
    // eslint-disable-next-line no-await-in-loop
    await repos.bundles.update(cb.bundleId, {
      scheduleStart: startsAt, scheduleEnd: endsAt, campaignId: id, status: 'Scheduled',
    });
  }

  const published = deriveCampaignStatus('Scheduled', startsAt, endsAt, now);
  await repos.campaigns.update(id, { status: published, publishedAt: now, startsAt, endsAt });

  return c.json({ status: published, created, failed });
});
```

Note the `configJson` on a `campaign_discount` holds the **form**, not the serialized metafield — `createDiscountInShopify` serialises it. If the column's meaning has drifted from the spec during Task 2, reconcile it here and say so in your report rather than silently passing a serialized config as a form.

- [ ] **Step 4: Run the suite**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/campaigns.ts src/api.integration.test.ts
git commit -m "feat(campaigns): publish a campaign onto one window"
```

---

## Task 7: Clone

**Files:**
- Modify: `src/routes/campaigns.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Produces: `POST /api/campaigns/:id/clone` returning `{ campaignId }`.

Clone is the only edit path for a published campaign, so it must produce a genuinely independent draft: a new `campaign` in `Draft`, copies of every `campaign_discount` with `publishState: 'pending'` and **no** `shopifyGid`, and copies of the `campaign_bundle` rows. It must not touch the source campaign at all.

- [ ] **Step 1: Write the failing test**

```ts
  it('clones into an independent Draft with no Shopify identities', async () => {
    const repos = seed({
      campaigns: [campaignRow({ id: 'c1', name: 'Spring', status: 'Published', scheduleMode: 'immediate' })],
      campaignDiscounts: [campaignDiscountRow({
        id: 'cd1', campaignId: 'c1', publishState: 'created', shopifyGid: 'gid://shopify/DiscountAutomaticNode/1',
      })],
      campaignBundles: [campaignBundleRow({ id: 'cb1', campaignId: 'c1', bundleId: 'b1' })],
    });

    const res = await app.request('/api/campaigns/c1/clone', {
      method: 'POST', headers: { 'x-shop-domain': 'mystore.myshopify.com' },
    }, env('development'));

    expect(res.status).toBe(200);
    const { campaignId } = (await res.json()) as { campaignId: string };
    expect(campaignId).not.toBe('c1');

    const clone = repos.campaigns.rows.find((r) => r.id === campaignId);
    expect(clone).toMatchObject({ status: 'Draft', publishedAt: null });

    const copied = repos.campaignDiscounts.rows.filter((r) => r.campaignId === campaignId);
    expect(copied).toHaveLength(1);
    // A clone that carried the original's gid would edit a LIVE discount.
    expect(copied[0]).toMatchObject({ publishState: 'pending', shopifyGid: null });

    expect(repos.campaignBundles.rows.filter((r) => r.campaignId === campaignId)).toHaveLength(1);

    // The source is untouched — that is the point of clone-to-edit.
    expect(repos.campaigns.rows.find((r) => r.id === 'c1')).toMatchObject({ status: 'Published' });
    expect(repos.campaignDiscounts.rows.find((r) => r.id === 'cd1')).toMatchObject({
      publishState: 'created', shopifyGid: 'gid://shopify/DiscountAutomaticNode/1',
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts -t "clones into an independent Draft"`
Expected: FAIL — route missing.

- [ ] **Step 3: Write the clone route**

Copy the campaign into a new `Draft` (name suffixed with " (copy)", `publishedAt: null`, window carried over), then copy each `campaign_discount` with a fresh id, `publishState: 'pending'`, `shopifyGid: null`, `publishError: null`, and each `campaign_bundle` with a fresh id. Never write to the source rows.

- [ ] **Step 4: Verify and commit**

Run: `npm run type-check && npx vitest run`

```bash
git add src/routes/campaigns.ts src/api.integration.test.ts
git commit -m "feat(campaigns): clone a published campaign into a new draft"
```

---

## Task 8: Client layer and the campaigns list

**Files:**
- Create: `web/campaigns/api.ts`, `web/campaigns/hooks.ts`, `web/Pages/Campaigns.tsx`
- Modify: `web/App.tsx`

**Interfaces:**
- Consumes: the routes from Tasks 5–7.
- Produces: `Campaign`, `CampaignDetail` types; `fetchCampaigns`, `fetchCampaign`, `createCampaign`, `updateCampaign`, `deleteCampaign`, `publishCampaign`, `cloneCampaign`; `useCampaigns`, `useCampaign`, `useCreateCampaign`, `useUpdateCampaign`, `useDeleteCampaign`, `usePublishCampaign`, `useCloneCampaign`.

Mirror `web/templates/api.ts` and `web/templates/hooks.ts` exactly — `apiFetch` + `createAuthenticatedFetch`, query keys `['campaigns']` and `['campaign', id]`, mutations invalidating `['campaigns']` (and `['discounts']` after a publish, since publishing creates discounts the list should refetch).

`web/Pages/Campaigns.tsx` at `/campaigns`: a Polaris `Page` titled "Campaigns", status tabs (All / Draft / Scheduled / Published / Ended) filtering client-side on the derived status, an `IndexTable` with name, status badge, discount and bundle counts and the window, a spinner while loading, a `Banner` on error, and an `EmptyState` when there are none. Draft rows navigate to `/campaigns/:id/edit`; everything else to `/campaigns/:id`. Reuse `components/StatusBadge`; add a `CAMPAIGN_STATUS_TONE` map beside it (`Draft: 'warning'`, `Scheduled: 'info'`, `Published: 'success'`, `Ended: 'neutral'`) matching the tone vocabulary `bundles/statusTone.ts` uses.

Add the three routes to `web/App.tsx` (`/campaigns`, `/campaigns/:id`, `/campaigns/:id/edit`) plus a `Campaigns` link in `NavMenu`. If `CampaignBuilder`/`CampaignDetail` do not exist yet, add minimal placeholders so the build compiles and say so in your report; Task 9 and 10 replace their bodies, not the route wiring.

- [ ] **Step 1: Write the client layer** (`api.ts`, then `hooks.ts`)
- [ ] **Step 2: Write the list page**
- [ ] **Step 3: Wire routes and nav**
- [ ] **Step 4: Verify** — `npm run lint:ci && npm run type-check && npx vitest run`
- [ ] **Step 5: Commit**

```bash
git add web/campaigns web/Pages/Campaigns.tsx web/App.tsx
git commit -m "feat(campaigns): campaigns list and client layer"
```

---

## Task 9: The four-step builder

**Files:**
- Create: `web/Pages/CampaignBuilder.tsx`, `web/campaigns/steps/DiscountsStep.tsx`, `BundlesStep.tsx`, `ScheduleStep.tsx`, `SummaryStep.tsx`

**Interfaces:**
- Consumes: `useCampaign`, `useUpdateCampaign`, `usePublishCampaign` (Task 8); `TierFields` from `web/templates/forms/TierFields`; `ScheduleCard` from `web/components/ScheduleCard`; `toUtcIso`/`fromUtcIso` from `web/lib/schedule`; `useBundles` from `web/bundles/hooks`.

The builder is a view over a `Draft` campaign, not a buffer in front of one: **each step saves through `useUpdateCampaign` as the merchant advances**, so closing the tab does not lose the work. Use a Polaris `Tabs` or a simple step header plus Back/Next buttons; the step index is local state, everything else is server state.

- **DiscountsStep** — a table of the campaign's discounts with name, engine, method and config size, plus Add (opens `TierFields` in a `Modal`, seeded from a template's defaults or blank) and Remove. Only `tier` is authorable in this slice, matching E5's Stage 1 — a `bundle` or `special` row renders a warning `Banner` rather than a broken form.
- **BundlesStep** — a multi-select over `useBundles()`. Plus-gated with the same non-blocking upgrade prompt E6 uses. A bundle owned by a *live* campaign is shown disabled with the owning campaign's name, never silently omitted — a missing row reads as a bug.
- **ScheduleStep** — immediate vs window, and when windowed, `ScheduleCard`. Reusing that component is what stops the campaign and bundle surfaces disagreeing about what a window means.
- **SummaryStep** — what will be created, the combined config size against 10 KB, the window in local time, and a one-way `Banner` before **Publish campaign**. On success navigate to `/campaigns/:id`; on failure show the server's `error.message`.

- [ ] **Step 1: Write the builder shell** (step header, save-on-advance, loading/error/not-found states)
- [ ] **Step 2: Write DiscountsStep**
- [ ] **Step 3: Write BundlesStep**
- [ ] **Step 4: Write ScheduleStep**
- [ ] **Step 5: Write SummaryStep with publish**
- [ ] **Step 6: Verify** — `npm run lint:ci && npm run type-check && npx vitest run`
- [ ] **Step 7: Commit**

```bash
git add web/Pages/CampaignBuilder.tsx web/campaigns/steps
git commit -m "feat(campaigns): four-step campaign builder"
```

---

## Task 10: Detail page and the bundle lock

**Files:**
- Create: `web/Pages/CampaignDetail.tsx`
- Modify: `web/Pages/BundleEditor.tsx`

**Interfaces:**
- Consumes: `useCampaign`, `useCloneCampaign` (Task 8); `isCampaignLocking`, `deriveCampaignStatus` (Task 3) — import the types from `src/lib/campaignStatus`.

`CampaignDetail` at `/campaigns/:id` is read-only: a locked `Banner` explaining that published campaigns are changed by cloning, the window, the discounts with their `shopifyGid` and per-row publish state (a failed row shows its `publishError` in a critical `Banner`), the bundles, and **Clone to edit** as the primary action, navigating to the new draft's builder.

`BundleEditor` gains the lock: when the bundle's `campaignId` names a campaign that is still locking, the **Schedule card is read-only** with a `Banner` naming the campaign and linking to it. Without that, a merchant edits a bundle's window and silently desynchronises it from the campaign that owns it.

- [ ] **Step 1: Write CampaignDetail**
- [ ] **Step 2: Add the campaign lock to BundleEditor's Schedule card**
- [ ] **Step 3: Verify** — `npm run lint:ci && npm run type-check && npx vitest run`
- [ ] **Step 4: Check it in the real app**

Run `npm run dev`, create a campaign, add a tier discount and a bundle, schedule it a few minutes out, publish, and confirm: the discount appears in Shopify admin as `SCHEDULED` with the campaign's dates, the bundle's `scheduleStart`/`scheduleEnd` match it, and the bundle editor shows the lock. Then trigger the cron with `npm run cron` after the window opens and confirm the bundle's metafield is written. If the app cannot be started here (port in use, no Shopify credentials), say so plainly rather than claiming it was checked.

- [ ] **Step 5: Commit**

```bash
git add web/Pages/CampaignDetail.tsx web/Pages/BundleEditor.tsx
git commit -m "feat(campaigns): campaign detail and the bundle ownership lock"
```

---

## Final verification

- [ ] **Run everything**

```bash
npm run type-check
npm run lint:ci
npx vitest run
npm run check
```

- [ ] **Confirm the tables and the lock**

```bash
npx wrangler d1 execute cloudflare-shopify-starter-db --local \
  --command "SELECT c.id, c.status, c.starts_at, c.ends_at,
                    (SELECT COUNT(*) FROM campaign_discount d WHERE d.campaign_id = c.id) AS discounts,
                    (SELECT COUNT(*) FROM campaign_bundle b WHERE b.campaign_id = c.id) AS bundles
             FROM campaign c;"
```

Expected for a published campaign: a derived status, both timestamps set, and non-zero members. Then confirm its bundles carry the same window:

```bash
npx wrangler d1 execute cloudflare-shopify-starter-db --local \
  --command "SELECT id, campaign_id, schedule_start, schedule_end, status FROM bundle WHERE campaign_id IS NOT NULL;"
```

The bundle's `schedule_start`/`schedule_end` must equal the campaign's. That equality is the whole design — if it does not hold, the two halves will not fire together.
