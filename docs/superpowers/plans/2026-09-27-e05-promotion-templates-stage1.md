# E5 Promotion Templates — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant browses promotion templates, picks one, fills in numbers and products, and the app creates the discount and its function configuration in Shopify in a single mutation.

**Architecture:** Templates live in a global D1 table keyed by `slug`, seeded idempotently at install from a code-side catalogue. One `POST /api/discounts` route dispatches through a `DiscountEngineAdapter` — a name for the interface the three existing engine config modules already share — so the route never branches on discount type. The three `config.ts` modules move into `src/lib/discountEngines/` and the extensions import them from there, so the app and the Rust functions cannot disagree about the wire format.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Vitest, React 18 + Shopify Polaris 13, Shopify Admin GraphQL `2026-04`.

**Spec:** `docs/superpowers/specs/2026-09-27-e05-promotion-templates-design.md`

**Scope:** Stage 1 of §11 — foundation plus the `tier` form body. All three adapters ship and are unit-tested, so the dispatch is proven; the `bundle` and `special` form bodies are Stage 2 and get their own plan.

## Global Constraints

- All IDs are `crypto.randomUUID()`. Timestamps are ISO 8601 strings stored as `text()`.
- Booleans are stored as `integer` `0/1`; SQLite has no boolean type.
- All D1 access goes through a repository — no `createDb()` and no Drizzle query builder outside `src/db/repositories/`.
- `docs/erd.dbml` is updated in the SAME commit as the `schema.ts` edit and the generated migration.
- Secure routes by default: everything under `/api/*` is behind `requireShop`. Do not touch `PUBLIC_API_PATHS`.
- Fail loudly — never `?? ''`, a default, or a swallowed error masking a missing domain, token, function id, or config.
- Never pass secrets through cron/queue messages; tokens come from KV at processing time.
- The metafield contract is fixed and NOT to be "tidied": namespace `$app:discount-tier` / `$app:discount-bundle` / `$app:discount-special`, key `config`, 10 KB ceiling, and `rule_type` values `tier-discount`, `bundle-discount`, `special_discount` (the last one really does use an underscore).
- Admin API version is `2026-04` (`src/lib/graphqlAdmin.ts`), where `DiscountAutomaticAppInput` requires `functionId` — `functionHandle` is not available.
- Frontend uses Polaris components; every async UI shows a spinner/skeleton on load and a Polaris `Banner` on error.

## Review Focus

Five failure modes the spec implies but does not itself test. Each has a test assigned to the task that owns the code.

1. **`getMetafieldValueString` swallows errors and returns `"{}"`.** Server-side that would create a real discount with an empty configuration — a promotion that silently does nothing, or worse. The adapter must throw instead of emitting `{}`. (Task 2)
2. **A client supplying its own `type` or a pre-built config.** The template decides the engine; anything the client says about it is ignored. Otherwise a caller picks the function that prices a shopper's cart. (Task 8)
3. **An inactive template's slug.** `active = 0` means retired; it must 404 rather than quietly still work. (Task 6)
4. **The function not deployed on the shop.** Must fail loudly naming the missing function, never create a discount pointing at some other function's id. (Task 7)
5. **A configuration over 10 KB.** Rejected with a 400 *before* any Shopify call, not after a partial write. (Task 8)

---

## File Structure

**Create:**
- `src/lib/discountEngines/tier.ts`, `bundle.ts`, `special.ts` — the three pure config modules, moved verbatim.
- `src/lib/discountEngines/adapters.ts` — `DiscountEngineAdapter`, the three adapters, `ENGINE_ADAPTERS`.
- `src/lib/discountEngines/adapters.test.ts`
- `src/lib/discountFunctions.ts` — `resolveDiscountFunctionId(env, shopDomain, handle)`.
- `src/lib/discountFunctions.test.ts`
- `src/lib/templates/catalogue.ts` — the seed catalogue and `TemplateSeed`.
- `src/db/repositories/TemplateRepository.ts` + `.test.ts`
- `src/routes/templates.ts` — the two read routes.
- `web/templates/api.ts`, `web/templates/hooks.ts`
- `web/components/TemplateCard.tsx`
- `web/Pages/Templates.tsx`, `web/Pages/TemplateCreate.tsx`
- `web/templates/forms/TierFields.tsx`

**Modify:**
- `extensions/discount-{tier,bundle,special}-ui/src/config.ts` → re-export from the moved module.
- `src/db/schema.ts`, `docs/erd.dbml`, `drizzle/migrations/` — the `template` table.
- `src/db/repositories/index.ts`, `inMemory.ts` — register the repository.
- `src/lifecycle/install.ts` — seed templates.
- `src/routes/discounts.ts` — add `POST /api/discounts`.
- `src/index.ts` — mount `templateRoutes`.
- `web/App.tsx` — two routes plus a nav link.
- `web/bundles/picker.ts` → `web/lib/picker.ts` (it is about Shopify's picker, not bundles).

**Deviation from the spec, deliberate:** §5.2 says `TemplateRepository` is "not added to `Repositories`". This plan **does** add it, because `Repositories` already carries two non-scoped members — `shops` (unscoped by design) and `events` (`WebhookEventRepository`, outside the hierarchy entirely) — and the root `CLAUDE.md` says route handlers read `c.get('repos')`. A separate factory also exists for the install lifecycle, mirroring `createShopRepository`.

---

## Task 1: Move the engine config modules into `src/lib/discountEngines/`

**Files:**
- Create: `src/lib/discountEngines/tier.ts`, `src/lib/discountEngines/bundle.ts`, `src/lib/discountEngines/special.ts`
- Modify: `extensions/discount-tier-ui/src/config.ts`, `extensions/discount-bundle-ui/src/config.ts`, `extensions/discount-special-ui/src/config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: from `src/lib/discountEngines/tier.ts` — `METAFIELD_NAMESPACE`, `METAFIELD_KEY`, `METAFIELD_MAX_SIZE_BYTES`, types `SelectorType`/`DiscountType`/`ApplyTo`/`SelectionStrategy`/`Platform`/`TierItem`/`Tier`/`TierFormData`/`TierConfigOut`, and functions `buildTierConfig`, `validateTierConfig`, `getMetafieldValueString`, `getMetafieldSizeBytes`, `validateMetafieldSize`, `parseMetafield`, `newTier`. Equivalents from `bundle.ts` (`BundleFormData`, `buildBundleConfig`, `validateBundleConfig`, `newBundle`, `parseItems`) and `special.ts` (`SpecialFormData`, `TargetGroup`, `Special`, `buildSpecialConfig`, `validateSpecialConfig`, `newSpecial`, `newTarget`).

**Why this is first:** every later task imports these. It is also the task most likely to hit a build wall, and finding that out now is cheaper than after eight tasks.

- [ ] **Step 1: Move the three files verbatim**

```bash
git mv extensions/discount-tier-ui/src/config.ts    src/lib/discountEngines/tier.ts
git mv extensions/discount-bundle-ui/src/config.ts  src/lib/discountEngines/bundle.ts
git mv extensions/discount-special-ui/src/config.ts src/lib/discountEngines/special.ts
```

Do not edit the contents. These emit exactly the JSON the Rust serde contracts parse; a "tidy-up" here misprices real carts.

- [ ] **Step 2: Re-export from each extension so its own imports keep working**

Create `extensions/discount-tier-ui/src/config.ts`:

```ts
// The engine's wire format now lives in one place, shared with the Worker that
// also writes this metafield (src/lib/discountEngines/tier.ts). Two copies
// would drift, and the drift is silent: the app writes config the Rust
// function misreads and a real discount misprices at checkout.
export * from '../../../src/lib/discountEngines/tier';
```

Same shape for `bundle` and `special`, pointing at their own module.

- [ ] **Step 3: Verify the extensions still build — this is the go/no-go**

Run: `npx shopify app build`
Expected: all extensions build.

**If an extension refuses an import above its root**, take the fallback the spec names (§4.1) rather than forcing it: restore each extension's `config.ts` to its full copy (`git checkout` the deleted file from `HEAD`), keep `src/lib/discountEngines/*` as the source of truth, and add `src/lib/discountEngines/contract.test.ts` that imports both copies, runs both over the same fixture forms, and asserts identical output:

```ts
import { describe, expect, it } from 'vitest';
import * as shared from './tier';
import * as extension from '../../../extensions/discount-tier-ui/src/config';

const FORM: shared.TierFormData = {
  message: 'Buy more save more',
  applyTo: 'price',
  discountType: 'percentage',
  productDiscountSelectionStrategy: 'MAXIMUM',
  platform: 'BOTH',
  tiers: [{
    id: 't1',
    value: '20',
    selectorType: 'variant_id',
    targets: JSON.stringify([{ variantId: '123', productTitle: 'Shirt' }]),
    min_qty: '3',
  }],
};

describe('tier engine contract', () => {
  it('the extension copy and the shared module serialise identically', () => {
    expect(extension.getMetafieldValueString(FORM)).toBe(shared.getMetafieldValueString(FORM));
  });

  it('they agree on the namespace and key the Rust function reads', () => {
    expect(extension.METAFIELD_NAMESPACE).toBe(shared.METAFIELD_NAMESPACE);
    expect(extension.METAFIELD_KEY).toBe(shared.METAFIELD_KEY);
  });
});
```

Report which route you took in your report — the rest of the plan works either way.

- [ ] **Step 4: Verify types and tests**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(engines): move discount config modules into src/lib/discountEngines"
```

---

## Task 2: The `DiscountEngineAdapter` and registry

**Files:**
- Create: `src/lib/discountEngines/adapters.ts`, `src/lib/discountEngines/adapters.test.ts`

**Interfaces:**
- Consumes: the three modules from Task 1.
- Produces:
  - `type DiscountEngineType = 'tier' | 'bundle' | 'special'`
  - `interface DiscountEngineAdapter<TForm>` with `type`, `functionHandle`, `namespace`, `key: 'config'`, `validate(form): string[]`, `serialize(form): string`, `sizeBytes(form): number`, `maxBytes: number`
  - `ENGINE_ADAPTERS: Record<DiscountEngineType, DiscountEngineAdapter<never>>`
  - `getAdapter(type: DiscountEngineType): DiscountEngineAdapter<never>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/discountEngines/adapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ENGINE_ADAPTERS, getAdapter } from './adapters';
import type { TierFormData } from './tier';

const TIER_FORM: TierFormData = {
  message: 'Buy more save more',
  applyTo: 'price',
  discountType: 'percentage',
  productDiscountSelectionStrategy: 'MAXIMUM',
  platform: 'BOTH',
  tiers: [{
    id: 't1',
    value: '20',
    selectorType: 'variant_id',
    targets: JSON.stringify([{ variantId: '123', productTitle: 'Shirt' }]),
    min_qty: '3',
  }],
};

describe('ENGINE_ADAPTERS', () => {
  it('carries the exact wire contract each Rust function reads', () => {
    expect(ENGINE_ADAPTERS.tier).toMatchObject({
      type: 'tier', functionHandle: 'discount-tier', namespace: '$app:discount-tier', key: 'config',
    });
    expect(ENGINE_ADAPTERS.bundle).toMatchObject({
      type: 'bundle', functionHandle: 'discount-bundle', namespace: '$app:discount-bundle', key: 'config',
    });
    // NOT a typo: the special engine's rule_type uses an underscore while the
    // other two use hyphens. That is the Rust contract.
    expect(ENGINE_ADAPTERS.special).toMatchObject({
      type: 'special', functionHandle: 'discount-special', namespace: '$app:discount-special', key: 'config',
    });
  });

  it('serialises a tier form to the rule_type the function parses', () => {
    const json = JSON.parse(getAdapter('tier').serialize(TIER_FORM as never));
    expect(json.rule_type).toBe('tier-discount');
    expect(json.discount_tiers['20'].targets).toEqual([123]);
    expect(json.discount_tiers['20'].min_qty).toBe(3);
  });

  it('reports validation errors rather than throwing them', () => {
    const errors = getAdapter('tier').validate({ ...TIER_FORM, tiers: [] } as never);
    expect(errors.length).toBeGreaterThan(0);
  });

  // Review Focus #1 — the underlying getMetafieldValueString catches and
  // returns "{}". Server-side that creates a real discount with an empty
  // config: a promotion that silently does nothing at checkout.
  it('THROWS rather than emitting "{}" when a form cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => getAdapter('tier').serialize(circular as never)).toThrow();
  });

  it('measures size in bytes of the serialised config', () => {
    const adapter = getAdapter('tier');
    expect(adapter.sizeBytes(TIER_FORM as never)).toBe(
      new TextEncoder().encode(adapter.serialize(TIER_FORM as never)).length,
    );
    expect(adapter.maxBytes).toBe(10 * 1024);
  });

  it('rejects an unknown engine type loudly', () => {
    expect(() => getAdapter('nope' as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/discountEngines/adapters.test.ts`
Expected: FAIL — "Failed to resolve import './adapters'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/discountEngines/adapters.ts`:

```ts
import * as tier from './tier';
import * as bundle from './bundle';
import * as special from './special';

export type DiscountEngineType = 'tier' | 'bundle' | 'special';

/**
 * The interface the three engine modules already share, named.
 *
 * They arrived at it independently — each exports build/validate/size/parse
 * over its own form shape — so this adds no logic. What it adds is a single
 * dispatch point, so the create route never branches on discount type and a
 * fourth engine is one entry in the registry below.
 */
export interface DiscountEngineAdapter<TForm> {
  type: DiscountEngineType;
  /** Extension handle from shopify.extension.toml; resolves to a functionId. */
  functionHandle: string;
  /** The `$app:` metafield namespace the Rust function reads. */
  namespace: string;
  key: 'config';
  maxBytes: number;

  validate(form: TForm): string[];
  /** Throws on an unserialisable form — see the note in `serialize` below. */
  serialize(form: TForm): string;
  sizeBytes(form: TForm): number;
}

/**
 * `getMetafieldValueString` catches its own errors and returns "{}". That is
 * tolerable in the extension, where the merchant is looking at the form, and
 * dangerous here: the server would create a REAL discount carrying an empty
 * configuration, which the function reads as "no rules" — a promotion that
 * silently does nothing at checkout, with no error anywhere.
 *
 * So serialization goes through `buildX` + `JSON.stringify` directly and is
 * allowed to throw.
 */
function serializer<TForm>(build: (form: TForm) => unknown) {
  return (form: TForm): string => JSON.stringify(build(form));
}

const tierAdapter: DiscountEngineAdapter<tier.TierFormData> = {
  type: 'tier',
  functionHandle: 'discount-tier',
  namespace: tier.METAFIELD_NAMESPACE,
  key: 'config',
  maxBytes: tier.METAFIELD_MAX_SIZE_BYTES,
  validate: tier.validateTierConfig,
  serialize: serializer(tier.buildTierConfig),
  sizeBytes(form) {
    return new TextEncoder().encode(this.serialize(form)).length;
  },
};

const bundleAdapter: DiscountEngineAdapter<bundle.BundleFormData> = {
  type: 'bundle',
  functionHandle: 'discount-bundle',
  namespace: bundle.METAFIELD_NAMESPACE,
  key: 'config',
  maxBytes: bundle.METAFIELD_MAX_SIZE_BYTES,
  validate: bundle.validateBundleConfig,
  serialize: serializer(bundle.buildBundleConfig),
  sizeBytes(form) {
    return new TextEncoder().encode(this.serialize(form)).length;
  },
};

const specialAdapter: DiscountEngineAdapter<special.SpecialFormData> = {
  type: 'special',
  functionHandle: 'discount-special',
  namespace: special.METAFIELD_NAMESPACE,
  key: 'config',
  maxBytes: special.METAFIELD_MAX_SIZE_BYTES,
  validate: special.validateSpecialConfig,
  serialize: serializer(special.buildSpecialConfig),
  sizeBytes(form) {
    return new TextEncoder().encode(this.serialize(form)).length;
  },
};

export const ENGINE_ADAPTERS = {
  tier: tierAdapter,
  bundle: bundleAdapter,
  special: specialAdapter,
} as unknown as Record<DiscountEngineType, DiscountEngineAdapter<never>>;

/** Throws rather than returning undefined: an unknown engine means a corrupt
 *  template row, and continuing would write config no function reads. */
export function getAdapter(type: DiscountEngineType): DiscountEngineAdapter<never> {
  const adapter = ENGINE_ADAPTERS[type];
  if (!adapter) throw new Error(`[discountEngines] unknown engine type: ${type}`);
  return adapter;
}
```

If `bundle.ts` / `special.ts` do not export `METAFIELD_MAX_SIZE_BYTES`, read what they do export and use it; if they export nothing equivalent, use `10 * 1024` and say so in your report.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/discountEngines/adapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discountEngines/adapters.ts src/lib/discountEngines/adapters.test.ts
git commit -m "feat(engines): name the shared engine interface as DiscountEngineAdapter"
```

---

## Task 3: The `template` table

**Files:**
- Modify: `src/db/schema.ts`, `docs/erd.dbml`
- Create: `drizzle/migrations/00NN_*.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: the `template` table and `TemplateRow` = `typeof template.$inferSelect`.

- [ ] **Step 1: Add the table to the Drizzle schema**

Append to `src/db/schema.ts`:

```ts
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
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run d1:generate && npm run d1:migrate:local`
Expected: a new migration creating `template` with both indexes. Read the generated SQL and confirm it contains no `DROP TABLE`; if it does, stop and report rather than commit it.

- [ ] **Step 3: Mirror the table in the ERD**

Add to `docs/erd.dbml`, following the file's existing style:

```
Table template {
  id text [pk, note: 'crypto.randomUUID()']
  slug text [not null, unique, note: 'route key for /templates/:slug']
  name text [not null]
  description text [not null]
  example text
  category text [not null, note: 'merchant intent; drives gallery filters']
  symbol text
  type text [not null, note: 'tier | bundle | special — the engine, never shown to the merchant']
  defaults text [not null, note: 'JSON: partial form data the create page is seeded with']
  sort_order integer [not null, default: 0]
  active integer [not null, default: 1, note: '0/1']
  created_at text [not null]
  updated_at text [not null]

  Note: 'GLOBAL — deliberately has no shop_id. Curated content identical for every shop, with nothing to cascade on SHOP_REDACT. Second exception to the tenant rule after webhook_event.'

  indexes {
    slug [name: 'template_slug_unq', unique]
    (active, sort_order) [name: 'template_active_sort_idx']
  }
}
```

- [ ] **Step 4: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS — this task changes shape only.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts docs/erd.dbml drizzle/migrations
git commit -m "feat(templates): add the global template table"
```

---

## Task 4: `TemplateRepository`

**Files:**
- Create: `src/db/repositories/TemplateRepository.ts`, `src/db/repositories/TemplateRepository.test.ts`
- Modify: `src/db/repositories/index.ts`, `src/db/repositories/inMemory.ts`

**Interfaces:**
- Consumes: the `template` table (Task 3).
- Produces:
  - `type TemplateRow = typeof template.$inferSelect`
  - `interface TemplateSeed { slug; name; description; example?; category; symbol?; type: DiscountEngineType; defaults: string; sortOrder: number; active?: number }`
  - `interface ITemplateRepository { listActive(): Promise<TemplateRow[]>; findBySlug(slug: string): Promise<TemplateRow | null>; upsertMany(seeds: TemplateSeed[]): Promise<void> }`
  - `class TemplateRepository implements ITemplateRepository` (constructor `(db: Db)`)
  - `createTemplateRepository(d1: D1Database): ITemplateRepository` from `index.ts`
  - `templates: ITemplateRepository` added to `Repositories`
  - `InMemoryTemplateRepository` from `inMemory.ts` (constructor `(rows: TemplateRow[])`)

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/TemplateRepository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { TemplateRepository } from './TemplateRepository';
import { createFakeD1 } from './testing/fakeD1';

function repo(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  return { fake, repo: new TemplateRepository(createDb(fake.db)) };
}

describe('TemplateRepository', () => {
  it('lists only active templates, ordered', async () => {
    const { fake, repo: r } = repo();
    await r.listActive();

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^select/i);
    expect(sql).toMatch(/"active" = \?/i);
    expect(sql).toMatch(/order by/i);
    expect(params).toContain(1);
  });

  it('finds by slug', async () => {
    const { fake, repo: r } = repo();
    await r.findBySlug('pct-off');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"slug" = \?/i);
    expect(params).toContain('pct-off');
  });

  // Review Focus #3 — a retired template must not keep working just because
  // someone kept the URL.
  it('does not return an inactive row from findBySlug', async () => {
    const { fake, repo: r } = repo();
    await r.findBySlug('retired');
    expect(fake.lastQuery().sql).toMatch(/"active" = \?/i);
  });

  it('returns null, never undefined, for a miss', async () => {
    const { repo: r } = repo([]);
    await expect(r.findBySlug('nope')).resolves.toBeNull();
  });

  it('is unscoped by design — it never binds a shop id', async () => {
    const { fake, repo: r } = repo();
    await r.listActive();
    expect(fake.lastQuery().sql).not.toMatch(/"shop_id"/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/TemplateRepository.test.ts`
Expected: FAIL — cannot resolve `./TemplateRepository`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repositories/TemplateRepository.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm';
import { template } from '../schema';
import type { Db } from './BaseRepository';

export type TemplateRow = typeof template.$inferSelect;

export interface TemplateSeed {
  slug: string;
  name: string;
  description: string;
  example?: string;
  category: string;
  symbol?: string;
  type: TemplateRow['type'];
  /** Already-serialised JSON of the partial form data. */
  defaults: string;
  sortOrder: number;
  active?: number;
}

export interface ITemplateRepository {
  listActive(): Promise<TemplateRow[]>;
  findBySlug(slug: string): Promise<TemplateRow | null>;
  upsertMany(seeds: TemplateSeed[]): Promise<void>;
}

/**
 * Promotion templates.
 *
 * DELIBERATELY OUTSIDE the BaseRepository/ShopScopedRepository hierarchy, and
 * the second table in this app with no tenant, after `webhook_event`.
 *
 * `template` rows are curated content: identical for every shop, carrying no
 * merchant data, with nothing to cascade on SHOP_REDACT. Extending
 * `ShopScopedRepository` would require a `shopId` this table does not have, and
 * would advertise an isolation guarantee that protects nothing here.
 *
 * Reads are filtered on `active = 1` rather than exposing a flag, so a retired
 * template cannot be resurrected by whoever still has the URL.
 */
export class TemplateRepository implements ITemplateRepository {
  constructor(private readonly db: Db) {}

  async listActive(): Promise<TemplateRow[]> {
    return this.db
      .select()
      .from(template)
      .where(eq(template.active, 1))
      .orderBy(asc(template.sortOrder), asc(template.name))
      .all();
  }

  async findBySlug(slug: string): Promise<TemplateRow | null> {
    const row = await this.db
      .select()
      .from(template)
      .where(and(eq(template.slug, slug), eq(template.active, 1)))
      .get();
    // Drizzle's `.get()` yields undefined; normalise once so no call site guesses.
    return row ?? null;
  }

  /**
   * Idempotent seed, keyed by slug. Re-running is a no-op beyond refreshing
   * copy, which is what lets install re-seed on every install without
   * duplicating rows or needing a migration when wording changes.
   */
  async upsertMany(seeds: TemplateSeed[]): Promise<void> {
    const now = new Date().toISOString();
    for (const seed of seeds) {
      const existing = await this.db
        .select({ id: template.id })
        .from(template)
        .where(eq(template.slug, seed.slug))
        .get();

      if (existing) {
        await this.db
          .update(template)
          .set({
            name: seed.name,
            description: seed.description,
            example: seed.example ?? null,
            category: seed.category,
            symbol: seed.symbol ?? null,
            type: seed.type,
            defaults: seed.defaults,
            sortOrder: seed.sortOrder,
            active: seed.active ?? 1,
            updatedAt: now,
          })
          .where(eq(template.slug, seed.slug));
      } else {
        await this.db.insert(template).values({
          id: crypto.randomUUID(),
          slug: seed.slug,
          name: seed.name,
          description: seed.description,
          example: seed.example ?? null,
          category: seed.category,
          symbol: seed.symbol ?? null,
          type: seed.type,
          defaults: seed.defaults,
          sortOrder: seed.sortOrder,
          active: seed.active ?? 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
}
```

- [ ] **Step 4: Register it**

In `src/db/repositories/index.ts`: import `TemplateRepository` and its types, re-export both, add `templates: ITemplateRepository` to the `Repositories` interface, construct it in `createRepositoriesFromDb` (`templates: new TemplateRepository(db)`), and add a standalone factory beside `createShopRepository`:

```ts
/** For the install lifecycle, which seeds templates with no request context. */
export function createTemplateRepository(d1: D1Database): ITemplateRepository {
  return new TemplateRepository(createDb(d1));
}
```

- [ ] **Step 5: Add the in-memory fake**

In `src/db/repositories/inMemory.ts`, add `InMemoryTemplateRepository` implementing the same interface over an array (filtering `active === 1` in both reads, matching the real queries), and add `templates: new InMemoryTemplateRepository(seed.templates ?? [])` to `createInMemoryRepositories`, with `templates?: TemplateRow[]` on its seed type.

- [ ] **Step 6: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories
git commit -m "feat(templates): add the unscoped TemplateRepository"
```

---

## Task 5: The seed catalogue and install-time seeding

**Files:**
- Create: `src/lib/templates/catalogue.ts`, `src/lib/templates/catalogue.test.ts`
- Modify: `src/lifecycle/install.ts`

**Interfaces:**
- Consumes: `TemplateSeed` (Task 4), `TierFormData` (Task 1).
- Produces: `TEMPLATE_CATALOGUE: TemplateSeed[]`, `seedTemplates(d1: D1Database): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/templates/catalogue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATALOGUE } from './catalogue';
import { getAdapter } from '../discountEngines/adapters';

describe('TEMPLATE_CATALOGUE', () => {
  it('has unique slugs — the slug is the route key', () => {
    const slugs = TEMPLATE_CATALOGUE.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every template names an engine that exists', () => {
    for (const t of TEMPLATE_CATALOGUE) {
      expect(() => getAdapter(t.type)).not.toThrow();
    }
  });

  it('every template ships parseable defaults', () => {
    for (const t of TEMPLATE_CATALOGUE) {
      expect(() => JSON.parse(t.defaults)).not.toThrow();
    }
  });

  it('ships the three tier templates Stage 1 covers', () => {
    expect(TEMPLATE_CATALOGUE.map((t) => t.slug).sort())
      .toEqual(['buy-more', 'clearance', 'pct-off']);
    expect(TEMPLATE_CATALOGUE.every((t) => t.type === 'tier')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/templates/catalogue.test.ts`
Expected: FAIL — cannot resolve `./catalogue`.

- [ ] **Step 3: Write the catalogue**

Create `src/lib/templates/catalogue.ts`:

```ts
import { createTemplateRepository } from '../../db/repositories';
import type { TemplateSeed } from '../../db/repositories';
import type { TierFormData } from '../discountEngines/tier';

/**
 * The shipped promotion templates.
 *
 * Defaults choose the SHAPE of a promotion, never the numbers — a template that
 * pre-filled "20%" would be guessing at the merchant's margin. Values stay
 * blank; the merchant fills them in.
 *
 * Stage 1 ships the three that resolve to the `tier` engine. The bundle and
 * special templates arrive with their form bodies in Stage 2.
 */
function tierDefaults(over: Partial<TierFormData>): string {
  const base: TierFormData = {
    message: '',
    applyTo: 'price',
    discountType: 'percentage',
    productDiscountSelectionStrategy: 'MAXIMUM',
    platform: 'BOTH',
    tiers: [],
  };
  return JSON.stringify({ ...base, ...over });
}

const emptyTier = (id: string, minQty: string) => ({
  id, value: '', selectorType: 'variant_id' as const, targets: '[]', min_qty: minQty,
});

export const TEMPLATE_CATALOGUE: TemplateSeed[] = [
  {
    slug: 'pct-off',
    name: 'Percentage off',
    description: 'Take a straight percentage off the products you choose.',
    example: '15% off this collection',
    category: 'Save %',
    symbol: '%',
    type: 'tier',
    sortOrder: 10,
    defaults: tierDefaults({ tiers: [emptyTier('t1', '')] }),
  },
  {
    slug: 'buy-more',
    name: 'Buy more, save more',
    description: 'The more a shopper buys, the bigger the discount.',
    example: 'Buy 3, get 20% off',
    category: 'Volume',
    symbol: '%',
    type: 'tier',
    sortOrder: 20,
    defaults: tierDefaults({
      tiers: [emptyTier('t1', '2'), emptyTier('t2', '3'), emptyTier('t3', '5')],
    }),
  },
  {
    slug: 'clearance',
    name: 'Clearance / RRP markdown',
    description: 'Mark products down from their compare-at price.',
    example: 'Was $80, now $60',
    category: 'Clearance',
    symbol: '%',
    type: 'tier',
    sortOrder: 30,
    defaults: tierDefaults({
      applyTo: 'compare_at_price',
      discountType: 'amount',
      tiers: [emptyTier('t1', '')],
    }),
  },
];

/** Idempotent: safe to run on every install. */
export async function seedTemplates(d1: D1Database): Promise<void> {
  await createTemplateRepository(d1).upsertMany(TEMPLATE_CATALOGUE);
}
```

- [ ] **Step 4: Seed at install**

In `src/lifecycle/install.ts`, after the cart-transform registration block, add:

```ts
  // 7. Seed the promotion templates (E5). Global content, idempotent by slug,
  // so every install refreshes copy without duplicating rows. Best-effort: a
  // failure here must never fail an install — the gallery is empty until the
  // next one, which is recoverable, unlike a blocked install.
  try {
    await seedTemplates(env.DB);
  } catch (err) {
    console.error(`[install] template seeding failed for ${shopDomain}:`, err);
  }
```

with `import { seedTemplates } from '../lib/templates/catalogue';` at the top. Renumber the trailing comment numbers if the file's existing numbering runs past 7.

- [ ] **Step 5: Run tests**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/templates src/lifecycle/install.ts
git commit -m "feat(templates): seed the promotion template catalogue at install"
```

---

## Task 6: Template read routes

**Files:**
- Create: `src/routes/templates.ts`
- Modify: `src/index.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `c.get('repos').templates` (Task 4).
- Produces: `templateRoutes` (Hono app); `GET /api/templates`, `GET /api/templates/:slug`; `TemplateDto { slug, name, description, example, category, symbol, type, defaults }` where `defaults` is parsed JSON.

- [ ] **Step 1: Write the failing test**

Append to `src/api.integration.test.ts`, using the file's existing `seed(...)` / `app.request(...)` / `env('development')` idiom (see the bundle tests for the shape). Add `templates` rows via the `seed` helper's new `templates` key:

```ts
describe('Template API (protected by requireShop)', () => {
  beforeEach(() => vi.clearAllMocks());

  const templateRow = (over: Record<string, unknown> = {}) => ({
    id: 'tpl-1',
    slug: 'pct-off',
    name: 'Percentage off',
    description: 'Take a percentage off.',
    example: '15% off',
    category: 'Save %',
    symbol: '%',
    type: 'tier',
    defaults: JSON.stringify({ platform: 'BOTH', tiers: [] }),
    sortOrder: 10,
    active: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('GET /api/templates returns active templates with defaults parsed', async () => {
    seed({ templates: [templateRow()] });

    const res = await app.request(
      '/api/templates',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { templates: Array<{ slug: string; defaults: unknown }> };
    expect(json.templates).toHaveLength(1);
    expect(json.templates[0].slug).toBe('pct-off');
    // Parsed, not a string — the client should not re-parse what we validated.
    expect(json.templates[0].defaults).toEqual({ platform: 'BOTH', tiers: [] });
  });

  it('GET /api/templates omits retired templates', async () => {
    seed({ templates: [templateRow({ slug: 'old', active: 0 })] });

    const res = await app.request(
      '/api/templates',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    const json = (await res.json()) as { templates: unknown[] };
    expect(json.templates).toEqual([]);
  });

  it('GET /api/templates/:slug returns one', async () => {
    seed({ templates: [templateRow()] });

    const res = await app.request(
      '/api/templates/pct-off',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { template: { slug: string; type: string } };
    expect(json.template).toMatchObject({ slug: 'pct-off', type: 'tier' });
  });

  // Review Focus #3
  it('GET /api/templates/:slug 404s a retired template', async () => {
    seed({ templates: [templateRow({ active: 0 })] });

    const res = await app.request(
      '/api/templates/pct-off',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });

  it('GET /api/templates/:slug 404s an unknown slug', async () => {
    seed({ templates: [] });

    const res = await app.request(
      '/api/templates/nope',
      { headers: { 'x-shop-domain': 'mystore.myshopify.com' } },
      env('development'),
    );

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts -t "Template API"`
Expected: FAIL — the routes do not exist (404 on the list, or a seed key error).

- [ ] **Step 3: Write the routes**

Create `src/routes/templates.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import type { TemplateRow } from '../db/repositories';

export const templateRoutes = new Hono<AppEnv>();

interface TemplateDto {
  slug: string;
  name: string;
  description: string;
  example: string | null;
  category: string;
  symbol: string | null;
  type: TemplateRow['type'];
  /** Parsed, not a string — the client should not re-parse what we stored. */
  defaults: unknown;
}

/**
 * `defaults` is our own JSON, written by the seed catalogue, so a parse failure
 * means a corrupt row rather than bad user input. Throwing surfaces it as a 500
 * with the slug rather than handing the client a template whose form cannot be
 * built.
 */
function toDto(row: TemplateRow): TemplateDto {
  let defaults: unknown;
  try {
    defaults = JSON.parse(row.defaults);
  } catch (err) {
    throw new Error(`[templates] template '${row.slug}' has unparseable defaults: ${String(err)}`);
  }
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    example: row.example,
    category: row.category,
    symbol: row.symbol,
    type: row.type,
    defaults,
  };
}

templateRoutes.get('/api/templates', async (c) => {
  const rows = await c.get('repos').templates.listActive();
  return c.json({ templates: rows.map(toDto) });
});

templateRoutes.get('/api/templates/:slug', async (c) => {
  const row = await c.get('repos').templates.findBySlug(c.req.param('slug'));
  // `findBySlug` already filters on active, so a retired template is absent
  // rather than served — see TemplateRepository.
  if (!row) return c.json({ error: 'Template not found' }, 404);
  return c.json({ template: toDto(row) });
});
```

- [ ] **Step 4: Mount the routes**

In `src/index.ts`, add `import { templateRoutes } from './routes/templates';` and `app.route('/', templateRoutes);` alongside the other route registrations.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/api.integration.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/templates.ts src/index.ts src/api.integration.test.ts
git commit -m "feat(templates): serve the template catalogue over the API"
```

---

## Task 7: Resolve a discount function id by handle

**Files:**
- Create: `src/lib/discountFunctions.ts`, `src/lib/discountFunctions.test.ts`

**Interfaces:**
- Consumes: `adminGraphql` from `./graphqlAdmin`.
- Produces: `resolveDiscountFunctionId(env: Env, shopDomain: string, handle: string): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/discountFunctions.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { resolveDiscountFunctionId } from './discountFunctions';
import type { Env } from '../types/env';

const ENV = {} as Env;
const SHOP = 'test.myshopify.com';

function functions(nodes: Array<{ id: string; handle: string; title: string; apiType: string }>) {
  vi.mocked(adminGraphql).mockResolvedValue({ data: { shopifyFunctions: { nodes } } } as never);
}

describe('resolveDiscountFunctionId', () => {
  beforeEach(() => vi.mocked(adminGraphql).mockReset());

  it('matches on handle, not on the display title', async () => {
    functions([
      { id: 'gid://shopify/Function/1', handle: 'discount-bundle', title: 'Buy X, Get Y', apiType: 'discount' },
      // The title has been renamed once already in this repo; the handle has not.
      { id: 'gid://shopify/Function/2', handle: 'discount-tier', title: 'Something Else Entirely', apiType: 'discount' },
    ]);

    await expect(resolveDiscountFunctionId(ENV, SHOP, 'discount-tier'))
      .resolves.toBe('gid://shopify/Function/2');
  });

  // Review Focus #4 — never fall back to "some other function", which would
  // create a discount priced by the wrong engine.
  it('throws loudly when the function is not deployed on the shop', async () => {
    functions([
      { id: 'gid://shopify/Function/1', handle: 'discount-bundle', title: 'Buy X, Get Y', apiType: 'discount' },
    ]);

    await expect(resolveDiscountFunctionId(ENV, SHOP, 'discount-tier'))
      .rejects.toThrow(/discount-tier/);
  });

  it('throws on GraphQL errors rather than returning a guess', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ errors: [{ message: 'boom' }] } as never);

    await expect(resolveDiscountFunctionId(ENV, SHOP, 'discount-tier')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/discountFunctions.test.ts`
Expected: FAIL — cannot resolve `./discountFunctions`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/discountFunctions.ts`:

```ts
import { adminGraphql } from './graphqlAdmin';
import type { Env } from '../types/env';

interface ShopifyFunctionsQueryResult {
  shopifyFunctions: {
    nodes: Array<{ id: string; handle: string; title: string; apiType: string }>;
  };
}

const SHOPIFY_FUNCTIONS_QUERY = /* GraphQL */ `
  query DiscountFunctions {
    shopifyFunctions(first: 50) {
      nodes {
        id
        handle
        title
        apiType
      }
    }
  }
`;

/**
 * Turn an extension handle (`discount-tier`) into the `functionId` that
 * `discountAutomaticAppCreate` requires on Admin API 2026-04.
 *
 * Matches on `handle`, NOT on `title`. The display names are merchant-facing
 * copy and have already been renamed once in this repo
 * ("chore(discount-fns): rename function display names to merchant language");
 * the handle is the extension's identity and does not move.
 *
 * Deliberately NOT cached. A stale Shopify id that nothing re-verifies is the
 * bug fixed in 21a0d3a, where a cached `cartTransformGid` left the app
 * permanently believing a transform was registered while checkout had none. One
 * extra Admin call per create is cheap; a permanently wrong id is not.
 */
export async function resolveDiscountFunctionId(
  env: Env,
  shopDomain: string,
  handle: string,
): Promise<string> {
  const res = await adminGraphql<ShopifyFunctionsQueryResult>(shopDomain, env, SHOPIFY_FUNCTIONS_QUERY);

  if (res.errors && res.errors.length > 0) {
    throw new Error(
      `[discountFunctions] GraphQL errors resolving shopifyFunctions for ${shopDomain}: ${JSON.stringify(res.errors)}`,
    );
  }

  const match = (res.data?.shopifyFunctions?.nodes ?? []).find((node) => node.handle === handle);
  if (!match) {
    // No fallback to "the first discount function" — that would create a
    // discount priced by an engine the merchant never chose.
    throw new Error(`[discountFunctions] function '${handle}' is not deployed for ${shopDomain}`);
  }
  return match.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/discountFunctions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discountFunctions.ts src/lib/discountFunctions.test.ts
git commit -m "feat(discounts): resolve a discount function id by extension handle"
```

---

## Task 8: `POST /api/discounts`

**Files:**
- Modify: `src/routes/discounts.ts`, `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `getAdapter` (Task 2), `c.get('repos').templates` (Task 4), `resolveDiscountFunctionId` (Task 7), `requireShopDomain` from `../lib/shopDomain`.
- Produces: `POST /api/discounts` taking `{ slug, title, startsAt, endsAt?, combinesWith?, form }` and returning `{ discountId }`.

- [ ] **Step 1: Write the failing test**

Append to `src/api.integration.test.ts`, inside a new describe, following the file's existing idiom. `adminGraphql` is already mocked at the top of the file:

```ts
describe('POST /api/discounts', () => {
  beforeEach(() => vi.clearAllMocks());

  const TIER_FORM = {
    message: 'Buy more save more',
    applyTo: 'price',
    discountType: 'percentage',
    productDiscountSelectionStrategy: 'MAXIMUM',
    platform: 'BOTH',
    tiers: [{
      id: 't1', value: '20', selectorType: 'variant_id',
      targets: JSON.stringify([{ variantId: '123' }]), min_qty: '3',
    }],
  };

  const templateRow = (over: Record<string, unknown> = {}) => ({
    id: 'tpl-1', slug: 'pct-off', name: 'Percentage off', description: 'd',
    example: null, category: 'Save %', symbol: '%', type: 'tier',
    defaults: JSON.stringify({ platform: 'BOTH', tiers: [] }),
    sortOrder: 10, active: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const post = (body: unknown) => app.request(
    '/api/discounts',
    {
      method: 'POST',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env('development'),
  );

  function mockFunctionsThenCreate() {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountAutomaticAppCreate: {
          automaticAppDiscount: { discountId: 'gid://shopify/DiscountAutomaticNode/1' },
          userErrors: [],
        } },
      } as never);
  }

  it('creates the discount and its config in one mutation', async () => {
    seed({ templates: [templateRow()] });
    mockFunctionsThenCreate();

    const res = await post({ slug: 'pct-off', title: 'Spring sale', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(200);
    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const input = (variables as { discount: Record<string, unknown> }).discount;
    expect(input.functionId).toBe('gid://shopify/Function/tier');
    const metafields = input.metafields as Array<{ namespace: string; key: string; value: string }>;
    expect(metafields[0].namespace).toBe('$app:discount-tier');
    expect(metafields[0].key).toBe('config');
    expect(JSON.parse(metafields[0].value).rule_type).toBe('tier-discount');
  });

  it('404s an unknown slug without calling Shopify', async () => {
    seed({ templates: [] });

    const res = await post({ slug: 'nope', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(404);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('400s an invalid form without calling Shopify', async () => {
    seed({ templates: [templateRow()] });

    const res = await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: { ...TIER_FORM, tiers: [] } });

    expect(res.status).toBe(400);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review Focus #5
  it('400s a config over 10KB before calling Shopify', async () => {
    seed({ templates: [templateRow()] });
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `t${i}`, value: String(i + 1), selectorType: 'variant_id',
      targets: JSON.stringify(Array.from({ length: 20 }, (_, j) => ({ variantId: String(j), productTitle: 'A long product title here' }))),
      min_qty: '1',
    }));

    const res = await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', form: { ...TIER_FORM, tiers: many } });

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/10 ?KB|too large/i);
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  // Review Focus #2 — the template decides the engine; the client does not.
  it('ignores a client-supplied type and uses the template’s engine', async () => {
    seed({ templates: [templateRow()] });
    mockFunctionsThenCreate();

    await post({ slug: 'pct-off', title: 'x', startsAt: '2026-10-01T00:00:00.000Z', type: 'special', form: TIER_FORM });

    const [, , , variables] = vi.mocked(adminGraphql).mock.calls[1];
    const metafields = (variables as { discount: { metafields: Array<{ namespace: string }> } }).discount.metafields;
    expect(metafields[0].namespace).toBe('$app:discount-tier');
  });

  it('502s on Shopify userErrors rather than reporting success', async () => {
    seed({ templates: [templateRow()] });
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: { shopifyFunctions: { nodes: [
          { id: 'gid://shopify/Function/tier', handle: 'discount-tier', title: 'Volume Discount', apiType: 'discount' },
        ] } },
      } as never)
      .mockResolvedValueOnce({
        data: { discountAutomaticAppCreate: { automaticAppDiscount: null, userErrors: [{ field: ['title'], message: 'Title is invalid' }] } },
      } as never);

    const res = await post({ slug: 'pct-off', title: '', startsAt: '2026-10-01T00:00:00.000Z', form: TIER_FORM });

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Title is invalid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts -t "POST /api/discounts"`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Write the route**

Add to `src/routes/discounts.ts`. The file currently imports only `Hono`, `DiscountRow`, the
sync helpers and `AppEnv` — so ALL of these are new imports:

```ts
import { adminGraphql } from '../lib/graphqlAdmin';
import { getAdapter } from '../lib/discountEngines/adapters';
import { resolveDiscountFunctionId } from '../lib/discountFunctions';
import { requireShopDomain } from '../lib/shopDomain';
```


```ts
const DISCOUNT_AUTOMATIC_APP_CREATE = /* GraphQL */ `
  mutation CreateAppDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

interface CreateBody {
  slug?: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
  form?: unknown;
}

interface DiscountCreateResult {
  discountAutomaticAppCreate: {
    automaticAppDiscount: { discountId: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
}

/**
 * Create a discount from a template.
 *
 * Takes the merchant's FORM DATA, never a pre-built config. A client that could
 * hand us a finished config could hand us any config, and this one lands on a
 * real shopper's bill. For the same reason the ENGINE comes from the stored
 * template, not from the request body.
 */
discountRoutes.post('/api/discounts', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateBody;

  if (!body.slug) return c.json({ error: 'slug is required' }, 400);
  if (!body.title || !body.title.trim()) return c.json({ error: 'title is required' }, 400);
  if (!body.startsAt) return c.json({ error: 'startsAt is required' }, 400);

  const template = await c.get('repos').templates.findBySlug(body.slug);
  if (!template) return c.json({ error: 'Template not found' }, 404);

  const adapter = getAdapter(template.type);
  const form = body.form as never;

  const errors = adapter.validate(form);
  if (errors.length > 0) return c.json({ error: errors.join(' '), errors }, 400);

  let value: string;
  try {
    value = adapter.serialize(form);
  } catch (err) {
    return c.json({ error: `Could not build the discount configuration: ${String(err)}` }, 400);
  }

  const sizeBytes = new TextEncoder().encode(value).length;
  if (sizeBytes > adapter.maxBytes) {
    return c.json(
      { error: `Discount configuration is too large (${(sizeBytes / 1024).toFixed(1)}KB). Maximum size is 10KB.` },
      400,
    );
  }

  const shopDomain = requireShopDomain(c);

  let functionId: string;
  try {
    functionId = await resolveDiscountFunctionId(c.env, shopDomain, adapter.functionHandle);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  const res = await adminGraphql<DiscountCreateResult>(shopDomain, c.env, DISCOUNT_AUTOMATIC_APP_CREATE, {
    discount: {
      title: body.title,
      functionId,
      startsAt: body.startsAt,
      ...(body.endsAt ? { endsAt: body.endsAt } : {}),
      ...(body.combinesWith ? { combinesWith: body.combinesWith } : {}),
      metafields: [{ namespace: adapter.namespace, key: adapter.key, type: 'json', value }],
    },
  });

  if (res.errors && res.errors.length > 0) {
    return c.json({ error: `Shopify rejected the discount: ${JSON.stringify(res.errors)}` }, 502);
  }

  const userErrors = res.data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return c.json({ error: userErrors.map((e) => e.message).join(' ') }, 502);
  }

  const discountId = res.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
  if (!discountId) {
    return c.json({ error: 'Shopify returned no discount id' }, 502);
  }

  // No D1 write: Shopify is the source of truth and the `discounts/create`
  // webhook already mirrors into the `discount` table. Inserting here would
  // race that webhook.
  return c.json({ discountId });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/api.integration.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/discounts.ts src/api.integration.test.ts
git commit -m "feat(discounts): create a discount and its config from a template"
```

---

## Task 9: The template gallery

**Files:**
- Create: `web/templates/api.ts`, `web/templates/hooks.ts`, `web/components/TemplateCard.tsx`, `web/Pages/Templates.tsx`
- Modify: `web/App.tsx`
- Move: `web/bundles/picker.ts` → `web/lib/picker.ts` (update importers)

**Interfaces:**
- Consumes: `GET /api/templates` (Task 6).
- Produces: `Template` type, `fetchTemplates`, `fetchTemplate`, `createDiscountFromTemplate`, `useTemplates()`, `useTemplate(slug)`, `useCreateDiscount()`, `<TemplateCard />`.

- [ ] **Step 1: Write the client layer**

Create `web/templates/api.ts`, mirroring `web/bundles/api.ts`:

```ts
import { apiFetch, type AuthenticatedFetch } from '../api';

export type DiscountEngineType = 'tier' | 'bundle' | 'special';

export interface Template {
  slug: string;
  name: string;
  description: string;
  example: string | null;
  category: string;
  symbol: string | null;
  type: DiscountEngineType;
  /** Partial form data for the engine named by `type`. */
  defaults: Record<string, unknown>;
}

export interface CreateDiscountInput {
  slug: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  combinesWith?: { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };
  form: unknown;
}

export function fetchTemplates(f: AuthenticatedFetch): Promise<{ templates: Template[] }> {
  return apiFetch<{ templates: Template[] }>(f, '/api/templates');
}

export function fetchTemplate(f: AuthenticatedFetch, slug: string): Promise<{ template: Template }> {
  return apiFetch<{ template: Template }>(f, `/api/templates/${encodeURIComponent(slug)}`);
}

export function createDiscountFromTemplate(
  f: AuthenticatedFetch,
  input: CreateDiscountInput,
): Promise<{ discountId: string }> {
  return apiFetch<{ discountId: string }>(f, '/api/discounts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
```

Create `web/templates/hooks.ts`:

```ts
import { useAppBridge } from '@shopify/app-bridge-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAuthenticatedFetch } from '../api';
import {
  createDiscountFromTemplate, fetchTemplate, fetchTemplates,
  type CreateDiscountInput,
} from './api';

export function useTemplates() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({ queryKey: ['templates'], queryFn: () => fetchTemplates(fetcher) });
}

export function useTemplate(slug: string | undefined) {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  return useQuery({
    queryKey: ['template', slug],
    queryFn: () => fetchTemplate(fetcher, slug as string),
    enabled: Boolean(slug),
  });
}

export function useCreateDiscount() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDiscountInput) => createDiscountFromTemplate(fetcher, input),
    // The `discounts/create` webhook mirrors the new row; invalidating makes
    // the list refetch rather than showing a stale page.
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['discounts'] }); },
  });
}
```

Confirm the react-query import path against `web/bundles/hooks.ts` and match it.

- [ ] **Step 2: Write the card**

Create `web/components/TemplateCard.tsx` — generic, taking content and an action rather than a discount:

```tsx
import { BlockStack, Badge, Button, Card, InlineStack, Text } from '@shopify/polaris';
import { SymbolTile } from './SymbolTile';

export interface TemplateCardProps {
  symbol?: string | null;
  name: string;
  description: string;
  example?: string | null;
  category: string;
  actionLabel?: string;
  onAction: () => void;
}

/** A pickable preset: tile, name, description, an example, and one action. */
export function TemplateCard({
  symbol, name, description, example, category, actionLabel = 'Use template', onAction,
}: TemplateCardProps) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <SymbolTile symbol={symbol ?? '%'} size={30} />
          <Text as="h3" variant="headingSm">{name}</Text>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">{description}</Text>
        {example && <Badge>{example}</Badge>}
        <InlineStack align="space-between" blockAlign="center">
          <Badge tone="info">{category}</Badge>
          <Button variant="primary" onClick={onAction}>{actionLabel}</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
```

Check `SymbolTile`'s real props before wiring it and match them.

- [ ] **Step 3: Write the gallery page**

Create `web/Pages/Templates.tsx`: a Polaris `Page` titled "Promotion templates", subtitle "No discount jargon required.", a `Spinner` while loading and a `Banner tone="critical"` on error, a filter `ButtonGroup` built from `['All', ...new Set(templates.map(t => t.category))]`, and an `InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400"` of `TemplateCard`s. `onAction` navigates to `/templates/${slug}`.

- [ ] **Step 4: Move the picker helper**

```bash
git mv web/bundles/picker.ts web/lib/picker.ts
git mv web/bundles/picker.test.ts web/lib/picker.test.ts
```

Update every importer (`web/Pages/BundleEditor.tsx` and any others) to `../lib/picker`. It is about Shopify's resource picker, not bundles.

- [ ] **Step 5: Wire routes and nav**

In `web/App.tsx` add `<Route path="/templates" element={<Templates />} />` and `<Route path="/templates/:slug" element={<TemplateCreate />} />` (the latter lands in Task 10 — add both routes there if `TemplateCreate` does not exist yet), plus `<Link to="/templates">Templates</Link>` in `NavMenu`.

- [ ] **Step 6: Verify**

Run: `npm run lint:ci && npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(templates): promotion template gallery"
```

---

## Task 10: The create page and tier form

**Files:**
- Create: `web/Pages/TemplateCreate.tsx`, `web/templates/forms/TierFields.tsx`
- Modify: `web/App.tsx` (if the route was not added in Task 9)

**Interfaces:**
- Consumes: `useTemplate(slug)`, `useCreateDiscount()` (Task 9); `TierFormData`, `newTier` from `src/lib/discountEngines/tier` — import the TYPES from there so the page and the server agree on the shape.
- Produces: no new exports.

- [ ] **Step 1: Write the tier fields component**

Create `web/templates/forms/TierFields.tsx`: given `value: TierFormData` and `onChange(next: TierFormData)`, render the shared settings (`discountType` select percentage/amount, `applyTo` select price/compare_at_price, `platform` select, `message` text field) and one row per tier with its `value`, a min-quantity field, and a product picker writing `targets` as a JSON string of `{ variantId, productTitle }` — the format `parseItems` expects. Use `flattenPickerSelection` / `selectionIdsFromVariants` from `web/lib/picker` and `VariantLabel` from `web/components/VariantLabel`. Add and remove tier rows with `newTier()`.

- [ ] **Step 2: Write the create page**

Create `web/Pages/TemplateCreate.tsx`:

- Read `slug` from `useParams`, load via `useTemplate(slug)`; `Spinner` while loading, `Banner tone="critical"` on error, and a "not found" `Card` when the query 404s.
- Seed form state once from `template.defaults` behind an `initializedRef`, the way `BundleEditor` does, so a background refetch cannot clobber an in-progress edit.
- Shared chrome: title `TextField`, `ScheduleCard` from `web/components/ScheduleCard` for start/end (converting with `toUtcIso` from `web/lib/schedule`), and a size hint showing `new TextEncoder().encode(JSON.stringify(...)).length` against 10 KB.
- Body: `{template.type === 'tier' && <TierFields value={form} onChange={setForm} />}`. Stage 2 adds `bundle` and `special`; until then render a Polaris `Banner tone="warning"` saying that template type is not available yet, rather than a blank page.
- Primary action `Create discount` → `useCreateDiscount().mutateAsync({ slug, title, startsAt, endsAt, form })` → on success `navigate('/discounts')`; on failure set a `Banner` with the server's message.

- [ ] **Step 3: Verify**

Run: `npm run lint:ci && npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Check it in the real app**

Run `npm run dev`, open `/templates`, pick "Percentage off", add a product, set 15%, and create. Confirm the discount appears in Shopify admin under Discounts and that its function settings show the tier you entered. If the app cannot be started in this environment (port in use, no Shopify credentials), say so plainly rather than claiming it was checked.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(templates): create-from-template page with the tier form"
```

---

## Final verification

- [ ] **Run everything**

```bash
npm run type-check
npm run lint:ci
npx vitest run
npm run check
npx shopify app build
```

All five must pass. `shopify app build` is what proves the Task 1 module move did not break the extensions.

- [ ] **Confirm the seeded templates exist**

```bash
npx wrangler d1 execute cloudflare-shopify-starter-db --local \
  --command "SELECT slug, type, active, sort_order FROM template ORDER BY sort_order;"
```

Expected: the three tier templates. If empty, install has not run since the migration — re-trigger the install lifecycle rather than inserting rows by hand.
