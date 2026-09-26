# Bundle Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant set an optional start/end datetime on a bundle, stored in UTC, so the bundle's cart-transform metafield is written when the window opens and cleared when it closes.

**Architecture:** Status is derived from the window by one pure function and persisted as the record of what has actually been written to Shopify. A 5-minute Cloudflare Cron Trigger runs one narrow unscoped scan for rows whose persisted status disagrees with their derived status, then does every read and write through normal shop-scoped repositories. The save path uses the same `shouldBeLive` gate, so "now" is handled at save time and the cron only handles boundaries that arrive while nobody is looking.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle ORM, Vitest, React 18 + Shopify Polaris 13, Shopify Admin GraphQL.

**Spec:** `docs/superpowers/specs/2026-09-27-bundle-scheduling-design.md`

## Global Constraints

- Schedule columns hold normalized UTC ISO-8601 strings only: `2026-10-03T09:00:00.000Z`, always via `new Date(input).toISOString()`. Fixed width, `Z`-suffixed. This is what makes SQLite string comparison chronological.
- An unparseable datetime is a `400` at the route. It is NEVER stored as `null` — that would silently make a bundle permanently live.
- All D1 access goes through a repository. No `createDb()` and no Drizzle query builder outside `src/db/repositories/`.
- Every shop-owned read/write in the cron goes through `createRepositories(env.DB, shopId)`. The only unscoped access is `DueBundleScanner`, which returns identifiers only.
- Fail loudly: never `?? ''` or a default to mask a missing domain, token, or GID.
- Never pass secrets through cron/queue messages — fetch tokens from KV at processing time via `getShopAccessToken`.
- `docs/erd.dbml` is updated in the SAME commit as the `schema.ts` edit and the generated migration.
- Frontend uses Polaris components; every async UI shows a spinner/skeleton on load and a Polaris `Banner` on error.
- Cron cadence is exactly `*/5 * * * *`.

## Review Focus

Five things the spec implies but does not itself test. Each has a test assigned to the task that owns the code.

1. **A window entirely in the past** sits at `Scheduled` and matches the activation predicate — it must go straight to `Ended` with no metafield write ever issued. (Task 6)
2. **`now` exactly equal to a boundary** — `now === start` must be `Active`, `now === end` must be `Ended`. Off-by-one here silently leaves a bundle live for a pass. (Task 1)
3. **A datetime with a non-`Z` offset** (`2026-10-03T09:00:00+10:00`) arriving at the route — it must be normalized to the same instant in `Z` form, not stored verbatim, or the index comparison lies. (Task 1, Task 5)
4. **A merge bundle whose shop has other merge bundles not in this pass** — the batched read-modify-write must preserve the untouched entries rather than replacing the array. (Task 4)
5. **A cross-tenant scanner result** — a due row for shop A must never be read or written through shop B's repositories, even if the scanner returned a wrong pairing. (Task 6)

---

## File Structure

**Create:**
- `src/lib/scheduleWindow.ts` — pure window logic: `deriveStatus`, `normalizeUtc`, `shouldBeLive`. No I/O, no Hono, no Drizzle.
- `src/lib/scheduleWindow.test.ts`
- `src/db/repositories/DueBundleScanner.ts` — the one unscoped, id-only due scan.
- `src/db/repositories/DueBundleScanner.test.ts`
- `src/lifecycle/bundleSchedule.ts` — the cron pass: scan, group by shop, apply transports, persist.
- `src/lifecycle/bundleSchedule.test.ts`
- `web/lib/schedule.ts` — local-wall-clock ⇄ UTC ISO conversion for the editor.
- `web/lib/schedule.test.ts`

**Modify:**
- `src/db/schema.ts` — add `scheduleError`, two indexes.
- `docs/erd.dbml` — mirror the above.
- `drizzle/migrations/` — generated migration.
- `src/db/repositories/inMemory.ts` — `scheduleError` default; `InMemoryDueBundleScanner`.
- `src/db/repositories/index.ts` — export and register the scanner.
- `src/lib/bundleMetafields.ts` — add `applyMergeBatch` (one read-modify-write for many changes).
- `src/routes/bundles.ts` — accept/return schedule fields, derive status, gate writes on `shouldBeLive`.
- `src/index.ts` — add the `scheduled` export.
- `wrangler.jsonc` — enable the cron trigger.
- `web/types/bundles.ts`, `web/bundles/api.ts` — schedule fields on the DTO and input.
- `web/Pages/BundleEditor.tsx` — the Schedule card.
- `web/Pages/Bundles.tsx` — schedule column + status badge.

**Naming note (deviation from spec §6.1):** the spec sketches `shouldBeLive(row)`. This plan implements `shouldBeLive(status)` — it only ever needs the status, and a status argument is callable from the route (which holds a draft status before any row exists) as well as the cron.

**Naming note (deviation from spec §5.2):** the spec describes the scan as a single `UNION ALL`. This plan issues two separate indexed `SELECT`s and concatenates in JS. Same two index lookups, same cost characteristics, no Drizzle union typing to fight. Both are still id-only and cross-shop.

---

## Task 1: Pure window logic

**Files:**
- Create: `src/lib/scheduleWindow.ts`
- Test: `src/lib/scheduleWindow.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ScheduledStatus = 'Active' | 'Scheduled' | 'Ended'`
  - `type BundleStatus = ScheduledStatus | 'Draft'`
  - `deriveStatus(start: string | null, end: string | null, now: string): ScheduledStatus`
  - `normalizeUtc(input: string): string` — throws `RangeError` on an unparseable value
  - `shouldBeLive(status: BundleStatus): boolean`
  - `assertWindowOrder(start: string | null, end: string | null): void` — throws `RangeError` when `start >= end`

- [ ] **Step 1: Write the failing test**

Create `src/lib/scheduleWindow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertWindowOrder, deriveStatus, normalizeUtc, shouldBeLive } from './scheduleWindow';

const START = '2026-10-03T09:00:00.000Z';
const END = '2026-10-05T23:00:00.000Z';
const BEFORE = '2026-10-01T00:00:00.000Z';
const INSIDE = '2026-10-04T00:00:00.000Z';
const AFTER = '2026-10-06T00:00:00.000Z';

describe('deriveStatus', () => {
  it.each([
    ['no bounds', null, null, INSIDE, 'Active'],
    ['start only, before', START, null, BEFORE, 'Scheduled'],
    ['start only, after', START, null, AFTER, 'Active'],
    ['end only, before', null, END, INSIDE, 'Active'],
    ['end only, after', null, END, AFTER, 'Ended'],
    ['both, before', START, END, BEFORE, 'Scheduled'],
    ['both, inside', START, END, INSIDE, 'Active'],
    ['both, after', START, END, AFTER, 'Ended'],
  ])('%s', (_label, start, end, now, expected) => {
    expect(deriveStatus(start, end, now)).toBe(expected);
  });

  // Review Focus #2 — an off-by-one here silently leaves a bundle live for a pass.
  it('treats now === start as Active (the window is open at its first instant)', () => {
    expect(deriveStatus(START, END, START)).toBe('Active');
  });

  it('treats now === end as Ended (the window is shut at its last instant)', () => {
    expect(deriveStatus(START, END, END)).toBe('Ended');
  });

  it('ends a window that is entirely in the past rather than activating it', () => {
    expect(deriveStatus(START, END, '2027-01-01T00:00:00.000Z')).toBe('Ended');
  });
});

describe('normalizeUtc', () => {
  it('passes a normalized UTC string through unchanged', () => {
    expect(normalizeUtc(START)).toBe(START);
  });

  // Review Focus #3 — stored verbatim, a non-Z offset makes the index comparison lie.
  it('converts a non-Z offset to the same instant in Z form', () => {
    expect(normalizeUtc('2026-10-03T19:00:00+10:00')).toBe('2026-10-03T09:00:00.000Z');
  });

  it('pads a second-less value to fixed width, so string compare stays chronological', () => {
    expect(normalizeUtc('2026-10-03T09:00:00Z')).toBe(START);
  });

  it('throws on an unparseable value rather than returning null', () => {
    expect(() => normalizeUtc('next tuesday')).toThrow(RangeError);
  });
});

describe('shouldBeLive', () => {
  it('is true only for Active', () => {
    expect(shouldBeLive('Active')).toBe(true);
    expect(shouldBeLive('Scheduled')).toBe(false);
    expect(shouldBeLive('Ended')).toBe(false);
    expect(shouldBeLive('Draft')).toBe(false);
  });
});

describe('assertWindowOrder', () => {
  it('accepts a start before its end', () => {
    expect(() => assertWindowOrder(START, END)).not.toThrow();
  });

  it('accepts either bound alone, and neither', () => {
    expect(() => assertWindowOrder(START, null)).not.toThrow();
    expect(() => assertWindowOrder(null, END)).not.toThrow();
    expect(() => assertWindowOrder(null, null)).not.toThrow();
  });

  it('rejects a start at or after its end', () => {
    expect(() => assertWindowOrder(END, START)).toThrow(RangeError);
    expect(() => assertWindowOrder(START, START)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/scheduleWindow.test.ts`
Expected: FAIL — "Failed to resolve import './scheduleWindow'".

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/scheduleWindow.ts`:

```ts
/**
 * Pure window logic for bundle scheduling. No I/O, no Hono, no Drizzle — the
 * route and the cron both import from here so there is exactly one definition
 * of what a schedule means.
 */

export type ScheduledStatus = 'Active' | 'Scheduled' | 'Ended';
export type BundleStatus = ScheduledStatus | 'Draft';

/**
 * What the window says the status should be right now.
 *
 * `Draft` is deliberately not a possible result: it is the merchant's manual
 * off-switch, owned by the merchant, and the caller skips derivation entirely
 * for a Draft row.
 *
 * Both comparisons are plain string compares, which is only correct because
 * every stored bound went through `normalizeUtc` — fixed-width, `Z`-suffixed,
 * so lexicographic order IS chronological order.
 *
 * The order of the two checks matters: a window entirely in the past has both
 * `now >= end` and (vacuously) an open start, and `Ended` is the honest answer.
 */
export function deriveStatus(
  start: string | null,
  end: string | null,
  now: string,
): ScheduledStatus {
  if (end !== null && now >= end) return 'Ended';
  if (start !== null && now < start) return 'Scheduled';
  return 'Active';
}

/**
 * The one way a datetime enters the database.
 *
 * Throws rather than returning null on a bad value: a `null` schedule bound
 * means "no bound", i.e. permanently live, which is the most dangerous thing a
 * parse failure could silently turn into.
 */
export function normalizeUtc(input: string): string {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new RangeError(`[scheduleWindow] not a parseable datetime: ${input}`);
  }
  return new Date(ms).toISOString();
}

/**
 * The single gate on whether a bundle's cart-transform metafield should be
 * written to Shopify. Both the save path and the cron pass go through this, so
 * a scheduled bundle cannot be live early via one of them.
 */
export function shouldBeLive(status: BundleStatus): boolean {
  return status === 'Active';
}

/** A closed window must be ordered. Either bound alone, or neither, is fine. */
export function assertWindowOrder(start: string | null, end: string | null): void {
  if (start !== null && end !== null && start >= end) {
    throw new RangeError(`[scheduleWindow] schedule start ${start} is not before end ${end}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/scheduleWindow.test.ts`
Expected: PASS, all assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduleWindow.ts src/lib/scheduleWindow.test.ts
git commit -m "feat(schedule): pure bundle window logic (deriveStatus, normalizeUtc, shouldBeLive)"
```

---

## Task 2: Schema, migration, ERD

**Files:**
- Modify: `src/db/schema.ts` (the `bundle` table, around lines 100-130)
- Modify: `docs/erd.dbml` (the `bundle` table, around line 88)
- Modify: `src/db/repositories/inMemory.ts:245-258` (`InMemoryBundleRepository.materialize`)
- Create: `drizzle/migrations/0006_*.sql` (generated, do not hand-write)

**Interfaces:**
- Consumes: nothing.
- Produces: `BundleRow.scheduleError: string | null`; indexes `bundle_due_start_idx`, `bundle_due_end_idx`.

- [ ] **Step 1: Add the column and indexes to the Drizzle schema**

In `src/db/schema.ts`, inside the `bundle` table definition, replace:

```ts
    scheduleStart: text('schedule_start'),
    scheduleEnd: text('schedule_end'),
    status: text('status', { enum: ['Active', 'Scheduled', 'Ended', 'Draft'] }).notNull(),
```

with:

```ts
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
```

and replace the table's index block:

```ts
  (t) => ({
    shopIdIdx: index('bundle_shop_id_idx').on(t.shopId),
  }),
```

with:

```ts
  (t) => ({
    shopIdIdx: index('bundle_shop_id_idx').on(t.shopId),
    // The scheduling cron's two due-scans. Deliberately NOT shop_id-leading:
    // the scan is cross-shop by design (see DueBundleScanner), and a
    // shop-leading index would not serve it.
    dueStartIdx: index('bundle_due_start_idx').on(t.status, t.scheduleStart),
    dueEndIdx: index('bundle_due_end_idx').on(t.status, t.scheduleEnd),
  }),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run d1:generate`
Expected: a new `drizzle/migrations/0006_*.sql` containing `ALTER TABLE bundle ADD schedule_error text;` and two `CREATE INDEX` statements. Read the generated file and confirm it contains no `DROP TABLE` — Drizzle occasionally rebuilds SQLite tables, and a rebuild of `bundle` would need review before it ships.

- [ ] **Step 3: Apply the migration locally**

Run: `npm run d1:migrate:local`
Expected: applies cleanly, reporting the new migration.

- [ ] **Step 4: Update the ERD in the same change**

In `docs/erd.dbml`, in the `bundle` table, after the `schedule_end` line add:

```
  schedule_error text [note: 'Last failed schedule transition; cleared on success']
```

and inside that table's `indexes { }` block add:

```
    (status, schedule_start) [name: 'bundle_due_start_idx']
    (status, schedule_end) [name: 'bundle_due_end_idx']
```

If the `bundle` table has no `indexes { }` block yet, add one containing the existing `bundle_shop_id_idx` as well:

```
  indexes {
    shop_id [name: 'bundle_shop_id_idx']
    (status, schedule_start) [name: 'bundle_due_start_idx']
    (status, schedule_end) [name: 'bundle_due_end_idx']
  }
```

- [ ] **Step 5: Give the in-memory fake the same default**

In `src/db/repositories/inMemory.ts`, in `InMemoryBundleRepository.materialize`, add `scheduleError: null,` to the defaults object, directly after `scheduleEnd: null,`:

```ts
      scheduleStart: null,
      scheduleEnd: null,
      scheduleError: null,
      blockOnFailure: 0,
```

- [ ] **Step 6: Verify the types still compile**

Run: `npm run type-check`
Expected: PASS. If `src/api.integration.test.ts:88` or any fixture constructs a `BundleRow` literal, add `scheduleError: null` there too.

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — this task changes no behaviour, only shape.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts docs/erd.dbml drizzle/migrations src/db/repositories/inMemory.ts src/api.integration.test.ts
git commit -m "feat(schedule): add bundle.schedule_error and the two due-scan indexes"
```

---

## Task 3: The due-bundle scanner

**Files:**
- Create: `src/db/repositories/DueBundleScanner.ts`
- Create: `src/db/repositories/DueBundleScanner.test.ts`
- Modify: `src/db/repositories/index.ts` (exports + a factory)
- Modify: `src/db/repositories/inMemory.ts` (an in-memory scanner for Task 6)

**Interfaces:**
- Consumes: `Db` from `./BaseRepository`, the `bundle` table from `../schema`.
- Produces:
  - `interface DueBundle { shopId: string; bundleId: string; to: 'Active' | 'Ended' }`
  - `interface IDueBundleScanner { findDue(now: string): Promise<DueBundle[]> }`
  - `class DueBundleScanner implements IDueBundleScanner` (constructor: `(db: Db)`)
  - `createDueBundleScanner(d1: D1Database): IDueBundleScanner` from `src/db/repositories/index.ts`
  - `class InMemoryDueBundleScanner implements IDueBundleScanner` (constructor: `(rows: BundleRow[])`) from `inMemory.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/DueBundleScanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { DueBundleScanner } from './DueBundleScanner';
import { createFakeD1 } from './testing/fakeD1';

const NOW = '2026-10-03T09:00:00.000Z';

function scanner(rowsFor: Parameters<typeof createFakeD1>[0] = () => []) {
  const fake = createFakeD1(rowsFor);
  return { fake, scanner: new DueBundleScanner(createDb(fake.db)) };
}

describe('DueBundleScanner', () => {
  it('issues one activation scan and one deactivation scan', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);
    expect(fake.queries).toHaveLength(2);
  });

  it('selects Scheduled rows whose start has arrived', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const [activation] = fake.queries;
    expect(activation.sql).toMatch(/"status" = \?/i);
    expect(activation.sql).toMatch(/"schedule_start" <= \?/i);
    expect(activation.params).toEqual(['Scheduled', NOW]);
  });

  it('selects Active rows whose end has arrived', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    const [, deactivation] = fake.queries;
    expect(deactivation.sql).toMatch(/"schedule_end" <= \?/i);
    expect(deactivation.params).toEqual(['Active', NOW]);
  });

  // The point of the escape hatch: it may read ids, and nothing else.
  it('selects identifiers only — never bundle data', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);

    for (const q of fake.queries) {
      expect(q.sql).toMatch(/^select /i);
      expect(q.sql).not.toMatch(/"name"/i);
      expect(q.sql).not.toMatch(/"price"/i);
      expect(q.sql).not.toMatch(/"metafield_gid"/i);
    }
  });

  it('tags each row with the transition its scan implies', async () => {
    const { scanner: s } = scanner((q) =>
      q.params[0] === 'Scheduled'
        ? [{ shop_id: 'shop-a', id: 'b1' }]
        : [{ shop_id: 'shop-b', id: 'b2' }]);

    await expect(s.findDue(NOW)).resolves.toEqual([
      { shopId: 'shop-a', bundleId: 'b1', to: 'Active' },
      { shopId: 'shop-b', bundleId: 'b2', to: 'Ended' },
    ]);
  });

  it('is unscoped by design — it never binds a shop id', async () => {
    const { fake, scanner: s } = scanner();
    await s.findDue(NOW);
    for (const q of fake.queries) {
      expect(q.sql).not.toMatch(/"shop_id" = \?/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/DueBundleScanner.test.ts`
Expected: FAIL — "Failed to resolve import './DueBundleScanner'".

- [ ] **Step 3: Write minimal implementation**

Create `src/db/repositories/DueBundleScanner.ts`:

```ts
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { bundle } from '../schema';
import type { Db } from './BaseRepository';

/** A bundle whose window has crossed a boundary, and which way it crossed. */
export interface DueBundle {
  shopId: string;
  bundleId: string;
  /**
   * ADVISORY. The scan that found the row, not a decision. The cron re-derives
   * the real target with `deriveStatus` once the row is loaded through a scoped
   * repository — which is what stops a window entirely in the past (Scheduled,
   * start passed, end also passed) from being activated for one pass before the
   * next pass ends it.
   */
  to: 'Active' | 'Ended';
}

export interface IDueBundleScanner {
  findDue(now: string): Promise<DueBundle[]>;
}

/**
 * The scheduling cron's due-scan.
 *
 * DELIBERATELY UNSCOPED, and the only unscoped access to `bundle` in the app.
 * The cron has no tenant — it runs for every shop at once — and the alternative
 * (loop every installed shop, build scoped repositories, query each) costs one
 * D1 round-trip per install every five minutes, almost all returning nothing,
 * scaling with installs rather than with work.
 *
 * The exception is kept narrow in the only way that matters: this class reads
 * IDENTIFIERS ONLY. It never selects a name, a price, an item, or a metafield
 * GID, and it has no write path. Everything the cron then does with these ids
 * goes back through `createRepositories(env.DB, shopId)`, which re-reads the row
 * under `where shop_id = ?` — so a bug here surfaces as a row that reads as
 * absent, not as a cross-tenant write.
 *
 * Both queries are served by `bundle_due_start_idx` / `bundle_due_end_idx`,
 * which are status-leading rather than shop-leading for exactly this reason.
 */
export class DueBundleScanner implements IDueBundleScanner {
  constructor(private readonly db: Db) {}

  /**
   * `now` is a parameter rather than read inside, so tests drive the clock
   * instead of mocking `Date`.
   *
   * Two queries rather than one `UNION ALL`: identical index usage, and the
   * result needs a per-branch tag anyway.
   */
  async findDue(now: string): Promise<DueBundle[]> {
    const ids = { shopId: bundle.shopId, bundleId: bundle.id };

    const activating = await this.db
      .select(ids)
      .from(bundle)
      .where(
        and(
          eq(bundle.status, 'Scheduled'),
          isNotNull(bundle.scheduleStart),
          lte(bundle.scheduleStart, now),
        ),
      )
      .all();

    const deactivating = await this.db
      .select(ids)
      .from(bundle)
      .where(
        and(
          eq(bundle.status, 'Active'),
          isNotNull(bundle.scheduleEnd),
          lte(bundle.scheduleEnd, now),
        ),
      )
      .all();

    return [
      ...activating.map((r) => ({ ...r, to: 'Active' as const })),
      ...deactivating.map((r) => ({ ...r, to: 'Ended' as const })),
    ];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/DueBundleScanner.test.ts`
Expected: PASS.

If the `params` assertions fail because Drizzle emits the `isNotNull` predicate with no binding (it does not bind for `IS NOT NULL`), the expected arrays above are already correct — `['Scheduled', NOW]`. If they fail for a different reason, print `fake.queries` and align the assertion with the SQL actually emitted rather than loosening it to `expect.anything()`.

- [ ] **Step 5: Register the scanner**

In `src/db/repositories/index.ts`, add to the imports:

```ts
import { DueBundleScanner, type IDueBundleScanner } from './DueBundleScanner';
```

add to the re-exports beside `export { WebhookEventRepository } ...`:

```ts
export { DueBundleScanner } from './DueBundleScanner';
```

add to the type exports:

```ts
export type { IDueBundleScanner, DueBundle } from './DueBundleScanner';
```

and add a factory beside `createShopRepository`:

```ts
/**
 * For the scheduling cron only. Deliberately NOT part of `Repositories`: it is
 * unscoped, and nothing built per-request has any business holding it.
 */
export function createDueBundleScanner(d1: D1Database): IDueBundleScanner {
  return new DueBundleScanner(createDb(d1));
}
```

Do **not** add it to the `Repositories` interface or to `createRepositoriesFromDb`.

- [ ] **Step 6: Add the in-memory scanner for Task 6**

In `src/db/repositories/inMemory.ts`, add near `InMemoryBundleRepository`:

```ts
/**
 * The in-memory twin of `DueBundleScanner`, for the cron's lifecycle tests.
 * Mirrors the real predicates — including that it returns ids only.
 */
export class InMemoryDueBundleScanner implements IDueBundleScanner {
  constructor(private readonly rows: BundleRow[]) {}

  async findDue(now: string): Promise<DueBundle[]> {
    const due: DueBundle[] = [];
    for (const r of this.rows) {
      if (r.status === 'Scheduled' && r.scheduleStart !== null && r.scheduleStart <= now) {
        due.push({ shopId: r.shopId, bundleId: r.id, to: 'Active' });
      } else if (r.status === 'Active' && r.scheduleEnd !== null && r.scheduleEnd <= now) {
        due.push({ shopId: r.shopId, bundleId: r.id, to: 'Ended' });
      }
    }
    return due;
  }
}
```

with the matching import at the top of the file:

```ts
import type { DueBundle, IDueBundleScanner } from './DueBundleScanner';
```

- [ ] **Step 7: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/repositories/DueBundleScanner.ts src/db/repositories/DueBundleScanner.test.ts src/db/repositories/index.ts src/db/repositories/inMemory.ts
git commit -m "feat(schedule): add the id-only cross-shop due-bundle scanner"
```

---

## Task 4: Batched merge-metafield writes

**Files:**
- Modify: `src/lib/bundleMetafields.ts` (add `applyMergeBatch` beside `upsertMergeConfig`, around line 342)
- Modify: `src/lib/bundleMetafields.test.ts`

**Interfaces:**
- Consumes: the existing private `readShopMergeBundles(env, shopDomain)`, `METAFIELDS_SET_MUTATION`, `METAFIELDS_DELETE_MUTATION`, `MergeBundleConfig`.
- Produces: `applyMergeBatch(env: Env, shopDomain: string, changes: { upserts: MergeBundleConfig[]; removeParentVariantIds: string[] }): Promise<{ metafieldGid: string | null }>` — `metafieldGid` is `null` when the batch empties the array and the metafield is deleted.

**Why this exists:** `$app:cart-transform.merge_bundles` is a SHOP-level metafield holding an array of every merge bundle. Calling `upsertMergeConfig` once per bundle in a cron pass is `2N` Admin calls where each write clobbers the array the previous one just built.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/bundleMetafields.test.ts` (follow the file's existing mocking of `adminGraphql`; if it mocks the module with `vi.mock('./graphqlAdmin')`, reuse that mock rather than inventing a second one):

```ts
describe('applyMergeBatch', () => {
  const ENV = {} as Env;
  const SHOP = 'test.myshopify.com';

  function existing(entries: MergeBundleConfig[]) {
    // First call reads the shop metafield, second performs the write.
    return vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            metafield: { value: JSON.stringify(entries) },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/9' }], userErrors: [] } },
      } as never);
  }

  beforeEach(() => vi.mocked(adminGraphql).mockReset());

  it('applies many changes in ONE read-modify-write', async () => {
    existing([]);
    await applyMergeBatch(ENV, SHOP, {
      upserts: [
        { parentVariantId: 'v1', price: 10, sources: ['gid://shopify/ProductVariant/1'] },
        { parentVariantId: 'v2', price: 20, sources: ['gid://shopify/ProductVariant/2'] },
      ],
      removeParentVariantIds: [],
    });

    expect(vi.mocked(adminGraphql)).toHaveBeenCalledTimes(2); // one read, one write
  });

  // Review Focus #4 — a replace-the-array bug here silently unpublishes every
  // merge bundle the shop has that this pass did not touch.
  it('preserves entries the batch does not mention', async () => {
    existing([
      { parentVariantId: 'untouched', price: 5, sources: ['gid://shopify/ProductVariant/7'] },
      { parentVariantId: 'v1', price: 1, sources: ['gid://shopify/ProductVariant/1'] },
    ]);

    await applyMergeBatch(ENV, SHOP, {
      upserts: [{ parentVariantId: 'v1', price: 99, sources: ['gid://shopify/ProductVariant/1'] }],
      removeParentVariantIds: [],
    });

    const [, writeCall] = vi.mocked(adminGraphql).mock.calls;
    const written = JSON.parse((writeCall[3] as { metafields: Array<{ value: string }> }).metafields[0].value);
    expect(written).toHaveLength(2);
    expect(written).toContainEqual(expect.objectContaining({ parentVariantId: 'untouched', price: 5 }));
    expect(written).toContainEqual(expect.objectContaining({ parentVariantId: 'v1', price: 99 }));
  });

  it('removes and upserts in the same pass', async () => {
    existing([
      { parentVariantId: 'gone', price: 5, sources: ['gid://shopify/ProductVariant/7'] },
      { parentVariantId: 'stays', price: 5, sources: ['gid://shopify/ProductVariant/8'] },
    ]);

    await applyMergeBatch(ENV, SHOP, {
      upserts: [{ parentVariantId: 'new', price: 3, sources: ['gid://shopify/ProductVariant/9'] }],
      removeParentVariantIds: ['gone'],
    });

    const [, writeCall] = vi.mocked(adminGraphql).mock.calls;
    const written = JSON.parse((writeCall[3] as { metafields: Array<{ value: string }> }).metafields[0].value);
    expect(written.map((e: MergeBundleConfig) => e.parentVariantId).sort()).toEqual(['new', 'stays']);
  });

  it('deletes the metafield and reports a null gid when the batch empties it', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            metafield: { value: JSON.stringify([{ parentVariantId: 'only', price: 5, sources: [] }]) },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: { metafieldsDelete: { deletedMetafields: [{ key: 'merge_bundles' }], userErrors: [] } },
      } as never);

    const result = await applyMergeBatch(ENV, SHOP, {
      upserts: [],
      removeParentVariantIds: ['only'],
    });

    expect(result.metafieldGid).toBeNull();
  });

  it('does not call Shopify at all for an empty batch', async () => {
    await applyMergeBatch(ENV, SHOP, { upserts: [], removeParentVariantIds: [] });
    expect(vi.mocked(adminGraphql)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bundleMetafields.test.ts`
Expected: FAIL — `applyMergeBatch is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/bundleMetafields.ts`, add after `upsertMergeConfig`:

```ts
/**
 * Apply many merge-bundle changes in ONE read-modify-write.
 *
 * `$app:cart-transform.merge_bundles` is a SHOP-level metafield holding an
 * array of every merge bundle the shop has. `upsertMergeConfig` /
 * `removeMergeConfig` each do their own read-modify-write, which is right for a
 * single save but wrong for the scheduling cron: N bundles crossing a boundary
 * in one pass would be 2N Admin calls, and each write would clobber the array
 * the previous one had just built.
 *
 * Entries the batch does not mention are preserved — this edits the array, it
 * does not replace it.
 *
 * Returns a null `metafieldGid` when the batch empties the array and the
 * metafield is deleted, so the caller records `Cleared` rather than pointing at
 * a metafield that no longer exists.
 */
export async function applyMergeBatch(
  env: Env,
  shopDomain: string,
  changes: { upserts: MergeBundleConfig[]; removeParentVariantIds: string[] },
): Promise<{ metafieldGid: string | null }> {
  const { upserts, removeParentVariantIds } = changes;
  // A no-op batch must not cost an Admin round-trip — a cron pass where only
  // `expand` bundles moved hits this every time.
  if (upserts.length === 0 && removeParentVariantIds.length === 0) {
    return { metafieldGid: null };
  }

  const { shopGid, entries } = await readShopMergeBundles(env, shopDomain);

  const touched = new Set([
    ...upserts.map((e) => e.parentVariantId),
    ...removeParentVariantIds,
  ]);
  const next = [...entries.filter((e) => !touched.has(e.parentVariantId)), ...upserts];

  if (next.length === 0) {
    const res = await adminGraphql<MetafieldsDeleteResponse>(shopDomain, env, METAFIELDS_DELETE_MUTATION, {
      metafields: [{ ownerId: shopGid, namespace: '$app:cart-transform', key: 'merge_bundles' }],
    });
    const errors = res.data?.metafieldsDelete?.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`[mergeBundlesConfig] delete failed for ${shopDomain}: ${JSON.stringify(errors)}`);
    }
    return { metafieldGid: null };
  }

  const res = await adminGraphql<MetafieldsSetResponse>(shopDomain, env, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: shopGid,
        namespace: '$app:cart-transform',
        key: 'merge_bundles',
        type: 'json',
        value: JSON.stringify(next),
      },
    ],
  });

  const errors = res.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`[mergeBundlesConfig] write failed for ${shopDomain}: ${JSON.stringify(errors)}`);
  }

  const metafieldGid = res.data?.metafieldsSet?.metafields?.[0]?.id ?? null;
  if (metafieldGid === null) {
    throw new Error(`[mergeBundlesConfig] write returned no metafield id for ${shopDomain}`);
  }
  return { metafieldGid };
}
```

Match the surrounding file's actual error-checking idiom — read `upsertMergeConfig`'s body and mirror how it reads `res.data` / `res.errors` and raises, rather than inventing a different shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bundleMetafields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bundleMetafields.ts src/lib/bundleMetafields.test.ts
git commit -m "feat(schedule): batch merge_bundles changes into one read-modify-write"
```

---

## Task 5: Route accepts the window and gates writes on status

**Files:**
- Modify: `src/routes/bundles.ts` — `BundleInput` (~line 48), `BundleDto` (~line 74), `toDto` (~line 158), the POST create (~line 730), the PUT patch (~line 880) and both metafield-write branches
- Modify: `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `deriveStatus`, `normalizeUtc`, `shouldBeLive`, `assertWindowOrder` from `../lib/scheduleWindow` (Task 1).
- Produces: `BundleDto.scheduleStart | scheduleEnd | scheduleError: string | null`; `BundleInput.scheduleStart?: string | null`, `scheduleEnd?: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/api.integration.test.ts`, following the file's existing pattern for building an app with in-memory repositories (reuse its helper rather than writing a new one):

```ts
describe('bundle scheduling', () => {
  it('stores a future window as Scheduled and writes NO metafield', async () => {
    const res = await post('/api/bundles', {
      name: 'Holiday bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2099-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(200);
    const { bundle } = await res.json();
    expect(bundle.status).toBe('Scheduled');
    expect(bundle.metafieldState).toBe('NotYet');
    expect(writeCompositionMock).not.toHaveBeenCalled();
  });

  it('stores an already-open window as Active and writes the metafield now', async () => {
    const res = await post('/api/bundles', {
      name: 'Live bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2020-01-01T00:00:00.000Z',
      scheduleEnd: '2099-01-01T00:00:00.000Z',
    });

    const { bundle } = await res.json();
    expect(bundle.status).toBe('Active');
    expect(writeCompositionMock).toHaveBeenCalledTimes(1);
  });

  it('stores a window entirely in the past as Ended and writes nothing', async () => {
    const res = await post('/api/bundles', {
      name: 'Old bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2020-01-01T00:00:00.000Z',
      scheduleEnd: '2020-02-01T00:00:00.000Z',
    });

    const { bundle } = await res.json();
    expect(bundle.status).toBe('Ended');
    expect(writeCompositionMock).not.toHaveBeenCalled();
  });

  // Review Focus #3 — stored verbatim, a non-Z offset makes the index lie.
  it('normalizes a non-Z offset to Z form before storing', async () => {
    const res = await post('/api/bundles', {
      name: 'Offset bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2099-10-03T19:00:00+10:00',
    });

    const { bundle } = await res.json();
    expect(bundle.scheduleStart).toBe('2099-10-03T09:00:00.000Z');
  });

  it('rejects an unparseable datetime with 400 rather than storing null', async () => {
    const res = await post('/api/bundles', {
      name: 'Bad bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: 'next tuesday',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a start at or after its end with 400', async () => {
    const res = await post('/api/bundles', {
      name: 'Backwards bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2099-02-01T00:00:00.000Z',
      scheduleEnd: '2099-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(400);
  });

  it('ignores a client trying to pin a future-windowed bundle Active', async () => {
    const res = await post('/api/bundles', {
      name: 'Pinned bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2099-01-01T00:00:00.000Z',
      status: 'Active',
    });

    const { bundle } = await res.json();
    expect(bundle.status).toBe('Scheduled');
  });

  it('honours Draft as the manual off-switch whatever the window says', async () => {
    const res = await post('/api/bundles', {
      name: 'Off bundle',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      items: [{ variantId: 'gid://shopify/ProductVariant/2', qty: 1 }],
      scheduleStart: '2020-01-01T00:00:00.000Z',
      status: 'Draft',
    });

    const { bundle } = await res.json();
    expect(bundle.status).toBe('Draft');
    expect(writeCompositionMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts`
Expected: FAIL — bundles come back `Draft` and `writeComposition` is called for the future-window case.

- [ ] **Step 3: Extend the request and response shapes**

In `src/routes/bundles.ts`, add to `BundleInput`:

```ts
  /** UTC ISO-8601, or null for "no bound". Normalized server-side. */
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
```

add to `BundleDto`:

```ts
  scheduleStart: string | null;
  scheduleEnd: string | null;
  scheduleError: string | null;
```

and add to the object `toDto` returns, beside `status`:

```ts
    scheduleStart: row.scheduleStart,
    scheduleEnd: row.scheduleEnd,
    scheduleError: row.scheduleError,
```

- [ ] **Step 4: Add the shared window-resolution helper**

In `src/routes/bundles.ts`, add near `assertOperationAllowed`, with the import:

```ts
import { assertWindowOrder, deriveStatus, normalizeUtc, shouldBeLive } from '../lib/scheduleWindow';
```

```ts
/**
 * Resolve the effective window and the status it implies.
 *
 * `status` is not freely settable by the client any more: the schedule owns
 * Active/Scheduled/Ended, and the client may only choose `Draft` (the manual
 * off-switch) or leave it to the window. A client sending `Active` on a future
 * window is ignored rather than rejected, so an older build cannot pin a bundle
 * live past its end date.
 *
 * Throws `HttpError(400)` — never returns a null bound for an unparseable
 * input, because a null bound means "no bound", i.e. permanently live.
 */
function resolveSchedule(
  requested: { scheduleStart?: string | null; scheduleEnd?: string | null; status?: string },
  current: { scheduleStart: string | null; scheduleEnd: string | null },
  now: string,
): { scheduleStart: string | null; scheduleEnd: string | null; status: Row['status'] } {
  const pick = (field: 'scheduleStart' | 'scheduleEnd'): string | null => {
    const value = requested[field];
    if (value === undefined) return current[field];
    if (value === null) return null;
    try {
      return normalizeUtc(value);
    } catch {
      throw new HttpError(400, `${field} is not a valid date and time.`);
    }
  };

  const scheduleStart = pick('scheduleStart');
  const scheduleEnd = pick('scheduleEnd');

  try {
    assertWindowOrder(scheduleStart, scheduleEnd);
  } catch {
    throw new HttpError(400, 'The schedule start must be before the schedule end.');
  }

  const status: Row['status'] =
    requested.status === 'Draft' ? 'Draft' : deriveStatus(scheduleStart, scheduleEnd, now);

  return { scheduleStart, scheduleEnd, status };
}
```

- [ ] **Step 5: Use it in the POST create**

In the POST handler, before `bundleRepo.create(...)`, add:

```ts
  let schedule: ReturnType<typeof resolveSchedule>;
  try {
    schedule = resolveSchedule(body, { scheduleStart: null, scheduleEnd: null }, new Date().toISOString());
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
```

then replace these three lines of the `create` call:

```ts
    scheduleStart: null,
    scheduleEnd: null,
    status: body.status ?? 'Draft',
```

with:

```ts
    scheduleStart: schedule.scheduleStart,
    scheduleEnd: schedule.scheduleEnd,
    scheduleError: null,
    status: schedule.status,
```

- [ ] **Step 6: Gate both POST metafield branches on `shouldBeLive`**

In the POST handler, change the two write conditions:

```ts
  if (row.operation === 'expand' && row.parentVariantId) {
```

to:

```ts
  // The schedule gate. Without it, a bundle scheduled for next Friday would
  // have its composition metafield written NOW — live at checkout a week early,
  // while the UI shows `Scheduled`.
  if (shouldBeLive(row.status) && row.operation === 'expand' && row.parentVariantId) {
```

and likewise:

```ts
  } else if (row.operation === 'merge' && row.parentVariantId) {
```

to:

```ts
  } else if (shouldBeLive(row.status) && row.operation === 'merge' && row.parentVariantId) {
```

- [ ] **Step 7: Use it in the PUT, and gate the PUT's writes**

In the PUT handler, after `effectiveStatus` is computed, replace:

```ts
  const effectiveStatus = body.status ?? existing.status;
```

with:

```ts
  let schedule: ReturnType<typeof resolveSchedule>;
  try {
    schedule = resolveSchedule(
      body,
      { scheduleStart: existing.scheduleStart, scheduleEnd: existing.scheduleEnd },
      new Date().toISOString(),
    );
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const effectiveStatus = schedule.status;
```

then, where the PUT builds `patch`, replace the line `if (body.status !== undefined) patch.status = body.status;` with:

```ts
  patch.status = schedule.status;
  patch.scheduleStart = schedule.scheduleStart;
  patch.scheduleEnd = schedule.scheduleEnd;
  // A merchant edit is a fresh attempt: whatever the cron failed at last time
  // is no longer the current state of this bundle.
  patch.scheduleError = null;
```

Finally, in the PUT's "phase 2" write section, add `shouldBeLive(merged.status) &&` to each condition that writes a metafield, exactly as in Step 6. The existing phase-1 CLEAR conditions stay as they are, and additionally: a bundle that is no longer live must be cleared. Add, after the existing phase-1 block:

```ts
  // Leaving the live window (or being switched to Draft) clears the transport,
  // the same thing the cron would do at the boundary — the cron only handles
  // boundaries that arrive while nobody is looking.
  if (!shouldBeLive(merged.status) && existing.metafieldState === 'Written' && existing.parentVariantId) {
    try {
      const shopDomain = requireShopDomain(c);
      if (prevOp === 'expand') await clearComposition(c.env, shopDomain, existing.parentVariantId);
      else if (prevOp === 'merge') await removeMergeConfig(c.env, shopDomain, existing.parentVariantId);
    } catch (err) {
      console.error(`[bundles] failed to clear transport for bundle ${id} leaving its window:`, err);
    }
    merged.metafieldState = 'Cleared';
    merged.metafieldGid = null;
    await bundleRepo.setMetafieldState(id, 'Cleared', null);
  }
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/api.integration.test.ts`
Expected: PASS, including the pre-existing bundle tests. If an existing test asserted `status: 'Draft'` on a create with no schedule, that expectation is now wrong — a bundle with no bounds derives `Active`. Update the assertion and say so in the commit body; do not re-add a `Draft` default.

- [ ] **Step 9: Verify the whole suite and types**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/routes/bundles.ts src/api.integration.test.ts
git commit -m "feat(schedule): accept a bundle window and gate metafield writes on status"
```

---

## Task 6: The cron pass — scan, group, derive, persist

**Files:**
- Create: `src/lifecycle/bundleSchedule.ts`
- Create: `src/lifecycle/bundleSchedule.test.ts`

This task builds the pass with status persistence only — no Admin calls. Task 7 adds the transports. Splitting here means the tenant-isolation and idempotency behaviour is proven before any network code is involved.

**Interfaces:**
- Consumes: `IDueBundleScanner`, `DueBundle`, `Repositories`, `IShopRepository` (Task 3); `deriveStatus`, `shouldBeLive` (Task 1).
- Produces:
  - `interface BundleScheduleDeps { scanner: IDueBundleScanner; shops: IShopRepository; reposFor(shopId: string): Repositories; getToken(domain: string): Promise<string | null>; transports: BundleTransports }`
  - `runBundleSchedule(env: Env, now: string, deps: BundleScheduleDeps): Promise<void>`
  - `createBundleScheduleDeps(env: Env): BundleScheduleDeps`

- [ ] **Step 1: Write the failing test**

Create `src/lifecycle/bundleSchedule.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runBundleSchedule, type BundleScheduleDeps, type BundleTransports } from './bundleSchedule';
import { createInMemoryRepositories, InMemoryDueBundleScanner } from '../db/repositories/inMemory';
import type { BundleRow, ShopRow } from '../db/repositories';
import type { Env } from '../types/env';

const NOW = '2026-10-03T12:00:00.000Z';
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';
const ENV = {} as Env;

function shop(id: string): ShopRow {
  return {
    id,
    myshopifyDomain: `${id}.myshopify.com`,
    status: 'installed',
    planName: 'Shopify Plus',
  } as ShopRow;
}

function bundleRow(over: Partial<BundleRow> & { id: string; shopId: string }): BundleRow {
  return {
    name: 'A bundle',
    operation: 'update',
    parentVariantId: null,
    price: null,
    metafieldState: 'NotYet',
    metafieldGid: null,
    scheduleStart: null,
    scheduleEnd: null,
    scheduleError: null,
    status: 'Scheduled',
    blockOnFailure: 0,
    createdAt: PAST,
    updatedAt: PAST,
    ...over,
  } as BundleRow;
}

function noopTransports(): BundleTransports {
  return {
    writeComposition: vi.fn(async () => ({ metafieldGid: 'gid://shopify/Metafield/1' })),
    clearComposition: vi.fn(async () => {}),
    applyMergeBatch: vi.fn(async () => ({ metafieldGid: null })),
  };
}

function harness(rows: BundleRow[], shops: ShopRow[], transports = noopTransports()) {
  // One repository set per shop, over ONE shared row array, so a cross-tenant
  // write would be visible to the other shop's repositories.
  const byShop = new Map<string, ReturnType<typeof createInMemoryRepositories>>();
  for (const s of shops) {
    byShop.set(s.id, createInMemoryRepositories(s.id, { shops, bundles: rows }));
  }
  const deps: BundleScheduleDeps = {
    scanner: new InMemoryDueBundleScanner(rows),
    shops: createInMemoryRepositories('unused', { shops }).shops,
    reposFor: (shopId) => {
      const repos = byShop.get(shopId);
      if (!repos) throw new Error(`no repositories for ${shopId}`);
      return repos;
    },
    getToken: vi.fn(async () => 'shpat_token'),
    transports,
  };
  return { deps, rows, transports, reposFor: (id: string) => byShop.get(id)! };
}

describe('runBundleSchedule', () => {
  it('activates a Scheduled bundle whose start has arrived', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Active');
  });

  it('ends an Active bundle whose end has arrived', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', status: 'Active', scheduleEnd: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Ended');
  });

  // Review Focus #1 — the scanner tags this 'Active'; re-deriving must override it.
  it('sends a window entirely in the past straight to Ended, never through Active', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST, scheduleEnd: PAST })];
    const { deps, reposFor, transports } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Ended');
    expect(transports.writeComposition).not.toHaveBeenCalled();
  });

  it('never touches a Draft bundle, whatever its window says', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', status: 'Draft', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Draft');
  });

  it('leaves a not-yet-due bundle alone', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: FUTURE })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
  });

  it('is idempotent — a second identical pass changes nothing', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);
    const afterFirst = await reposFor('shop-a').bundles.findById('b1');
    await runBundleSchedule(ENV, NOW, deps);

    expect(await reposFor('shop-a').bundles.findById('b1')).toEqual(afterFirst);
  });

  it('changes no status anywhere in a group whose shop has no token', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);
    deps.getToken = vi.fn(async () => null);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
  });

  it('skips an uninstalled shop', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const uninstalled = { ...shop('shop-a'), status: 'uninstalled' } as ShopRow;
    const { deps, reposFor } = harness(rows, [uninstalled]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
  });

  // Review Focus #5 — the scoped re-read is what makes a scanner bug harmless.
  it('never writes shop A’s row through shop B’s repositories', async () => {
    const rows = [bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST })];
    const { deps, reposFor } = harness(rows, [shop('shop-a'), shop('shop-b')]);
    // A deliberately wrong pairing, as a scanner bug would produce.
    deps.scanner = { findDue: async () => [{ shopId: 'shop-b', bundleId: 'b1', to: 'Active' }] };

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
    expect(await reposFor('shop-b').bundles.findById('b1')).toBeNull();
  });

  it('processes every shop in the pass, not just the first', async () => {
    const rows = [
      bundleRow({ id: 'b1', shopId: 'shop-a', scheduleStart: PAST }),
      bundleRow({ id: 'b2', shopId: 'shop-b', scheduleStart: PAST }),
    ];
    const { deps, reposFor } = harness(rows, [shop('shop-a'), shop('shop-b')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Active');
    expect((await reposFor('shop-b').bundles.findById('b2'))!.status).toBe('Active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lifecycle/bundleSchedule.test.ts`
Expected: FAIL — "Failed to resolve import './bundleSchedule'".

- [ ] **Step 3: Write minimal implementation**

Create `src/lifecycle/bundleSchedule.ts`:

```ts
import { createDueBundleScanner, createRepositories, createShopRepository } from '../db/repositories';
import type { DueBundle, IDueBundleScanner, IShopRepository, Repositories } from '../db/repositories';
import { getShopAccessToken } from '../lib/getShopAccessToken';
import { deriveStatus, shouldBeLive } from '../lib/scheduleWindow';
import type { Env } from '../types/env';

/**
 * The Admin-side effects the pass performs, injected so the lifecycle tests can
 * run the whole pass with no network. Task 7 fills these in; the pass itself
 * only needs to know they exist.
 */
export interface BundleTransports {
  writeComposition(
    env: Env,
    shopDomain: string,
    parentVariantGid: string,
    items: Array<{ variantId: string; qty: number; price: number }>,
    targetPrice: number | null,
  ): Promise<{ metafieldGid: string }>;
  clearComposition(env: Env, shopDomain: string, parentVariantGid: string): Promise<void>;
  applyMergeBatch(
    env: Env,
    shopDomain: string,
    changes: {
      upserts: Array<{ parentVariantId: string; price: number; sources: string[]; title?: string }>;
      removeParentVariantIds: string[];
    },
  ): Promise<{ metafieldGid: string | null }>;
}

export interface BundleScheduleDeps {
  scanner: IDueBundleScanner;
  shops: IShopRepository;
  reposFor(shopId: string): Repositories;
  getToken(domain: string): Promise<string | null>;
  transports: BundleTransports;
}

/** The production wiring. Tests build their own deps instead. */
export function createBundleScheduleDeps(env: Env): BundleScheduleDeps {
  // Transports are wired in Task 7.
  throw new Error('createBundleScheduleDeps is implemented in Task 7');
}

function groupByShop(due: DueBundle[]): Map<string, DueBundle[]> {
  const groups = new Map<string, DueBundle[]>();
  for (const row of due) {
    const existing = groups.get(row.shopId);
    if (existing) existing.push(row);
    else groups.set(row.shopId, [row]);
  }
  return groups;
}

/**
 * One scheduling pass.
 *
 * `now` is a parameter so tests drive the clock. The pass is idempotent: it
 * only ever acts on rows whose persisted status disagrees with their derived
 * status, and the status write is the LAST step — so a pass that dies half way
 * is simply redone next time for whatever it did not reach.
 */
export async function runBundleSchedule(
  env: Env,
  now: string,
  deps: BundleScheduleDeps,
): Promise<void> {
  const due = await deps.scanner.findDue(now);
  if (due.length === 0) return;

  for (const [shopId, group] of groupByShop(due)) {
    const shop = await deps.shops.findById(shopId);
    if (!shop || shop.status !== 'installed') {
      // The uninstall cascade will remove these rows; nothing to do and nothing
      // to warn about.
      continue;
    }

    const domain = shop.myshopifyDomain;
    if (!domain) {
      console.error(`[bundleSchedule] shop ${shopId} has no myshopify domain; skipping ${group.length} bundle(s)`);
      continue;
    }

    const token = await deps.getToken(domain);
    if (!token) {
      // No token means no Admin write is possible, and a status change without
      // the write would claim something untrue. Leave everything and retry next
      // pass.
      console.error(`[bundleSchedule] no access token for ${domain}; skipping ${group.length} bundle(s)`);
      continue;
    }

    // From here every read and write is scoped to this shop. The scanner's ids
    // are re-read under `where shop_id = ?`, so a wrong pairing from the
    // scanner reads as absent rather than reaching another tenant's row.
    const repos = deps.reposFor(shopId);

    for (const { bundleId } of group) {
      const row = await repos.bundles.findById(bundleId);
      if (!row) continue;

      // Draft is the merchant's manual off-switch — never scheduled over.
      if (row.status === 'Draft') continue;

      // The scanner's `to` was advisory. This is the decision: a window
      // entirely in the past derives `Ended` even though the activation scan
      // found it, so it never spends a pass live.
      const target = deriveStatus(row.scheduleStart, row.scheduleEnd, now);
      if (target === row.status) continue;

      try {
        // Task 7 performs the Admin transport here, before the status write.
        await repos.bundles.update(bundleId, { status: target, scheduleError: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bundleSchedule] bundle ${bundleId} (${domain}) failed to reach ${target}:`, err);
        // Status deliberately untouched: a bundle is never `Active` with
        // nothing written at checkout. One broken bundle does not stop the pass.
        await repos.bundles.update(bundleId, { scheduleError: message });
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lifecycle/bundleSchedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/bundleSchedule.ts src/lifecycle/bundleSchedule.test.ts
git commit -m "feat(schedule): cron pass with scoped execution and re-derived targets"
```

---

## Task 7: Wire the transports into the pass

**Files:**
- Modify: `src/lifecycle/bundleSchedule.ts`
- Modify: `src/lifecycle/bundleSchedule.test.ts`

**Interfaces:**
- Consumes: `writeComposition`, `clearComposition`, `applyMergeBatch`, `mergeConfigEntry` from `../lib/bundleMetafields` (Task 4); `toMoney` from `../lib/money`; `isPlusPlan`, `planGateReason` from `../lib/shopPlan`.
- Produces: a working `createBundleScheduleDeps(env: Env): BundleScheduleDeps`.

- [ ] **Step 1: Write the failing test**

Append to `src/lifecycle/bundleSchedule.test.ts`:

```ts
describe('runBundleSchedule transports', () => {
  function expandRow(over: Partial<BundleRow>): BundleRow {
    return bundleRow({
      id: 'b1',
      shopId: 'shop-a',
      operation: 'expand',
      parentVariantId: 'gid://shopify/ProductVariant/1',
      price: 1000,
      ...over,
    } as Partial<BundleRow> & { id: string; shopId: string });
  }

  it('writes the composition metafield when an expand bundle activates', async () => {
    const rows = [expandRow({ scheduleStart: PAST })];
    const { deps, transports, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.writeComposition).toHaveBeenCalledTimes(1);
    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Active');
    expect(row.metafieldState).toBe('Written');
  });

  it('clears the composition metafield when an expand bundle ends', async () => {
    const rows = [expandRow({ status: 'Active', scheduleEnd: PAST, metafieldState: 'Written' })];
    const { deps, transports, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.clearComposition).toHaveBeenCalledTimes(1);
    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Ended');
    expect(row.metafieldState).toBe('Cleared');
  });

  it('batches every merge change in a shop into ONE applyMergeBatch call', async () => {
    const rows = [
      bundleRow({ id: 'm1', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p1', price: 1000, scheduleStart: PAST }),
      bundleRow({ id: 'm2', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p2', price: 2000, scheduleStart: PAST }),
      bundleRow({ id: 'm3', shopId: 'shop-a', operation: 'merge', parentVariantId: 'p3', price: 3000, status: 'Active', scheduleEnd: PAST, metafieldState: 'Written' }),
    ];
    const { deps, transports } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect(transports.applyMergeBatch).toHaveBeenCalledTimes(1);
    const [, , changes] = vi.mocked(transports.applyMergeBatch).mock.calls[0];
    expect(changes.upserts.map((u) => u.parentVariantId).sort()).toEqual(['p1', 'p2']);
    expect(changes.removeParentVariantIds).toEqual(['p3']);
  });

  it('records the failure and leaves status untouched when the Admin write throws', async () => {
    const rows = [expandRow({ scheduleStart: PAST })];
    const transports = noopTransports();
    transports.writeComposition = vi.fn(async () => { throw new Error('Shopify is down'); });
    const { deps, reposFor } = harness(rows, [shop('shop-a')], transports);

    await runBundleSchedule(ENV, NOW, deps);

    const row = (await reposFor('shop-a').bundles.findById('b1'))!;
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleError).toContain('Shopify is down');
  });

  it('keeps processing the group after one bundle fails', async () => {
    const rows = [
      expandRow({ id: 'b1', scheduleStart: PAST }),
      expandRow({ id: 'b2', parentVariantId: 'gid://shopify/ProductVariant/2', scheduleStart: PAST }),
    ];
    const transports = noopTransports();
    transports.writeComposition = vi.fn(async (_e, _d, parent) => {
      if (parent.endsWith('/1')) throw new Error('nope');
      return { metafieldGid: 'gid://shopify/Metafield/2' };
    });
    const { deps, reposFor } = harness(rows, [shop('shop-a')], transports);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.status).toBe('Scheduled');
    expect((await reposFor('shop-a').bundles.findById('b2'))!.status).toBe('Active');
  });

  it('clears scheduleError on a later successful transition', async () => {
    const rows = [expandRow({ scheduleStart: PAST, scheduleError: 'an old failure' })];
    const { deps, reposFor } = harness(rows, [shop('shop-a')]);

    await runBundleSchedule(ENV, NOW, deps);

    expect((await reposFor('shop-a').bundles.findById('b1'))!.scheduleError).toBeNull();
  });

  it('refuses to activate an update bundle on a non-Plus shop, and says why', async () => {
    const rows = [bundleRow({ id: 'u1', shopId: 'shop-a', operation: 'update', scheduleStart: PAST })];
    const basic = { ...shop('shop-a'), planName: 'Basic', shopifyPlus: 0 } as ShopRow;
    const { deps, reposFor } = harness(rows, [basic]);

    await runBundleSchedule(ENV, NOW, deps);

    const row = (await reposFor('shop-a').bundles.findById('u1'))!;
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleError).toMatch(/plan/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lifecycle/bundleSchedule.test.ts`
Expected: FAIL — no transport is invoked and `metafieldState` never changes.

- [ ] **Step 3: Restructure the per-shop loop to plan, apply, then persist**

In `src/lifecycle/bundleSchedule.ts`, replace the inner `for (const { bundleId } of group)` loop with:

```ts
    const currency = shop.currency ?? 'USD';
    const plan = shop.planName ?? shop.plan ?? null;

    // Merge bundles share ONE shop-level metafield, so their changes are
    // collected across the whole group and applied in a single
    // read-modify-write. Per-variant `expand` changes are independent and go
    // one at a time.
    const mergeUpserts: Array<{ parentVariantId: string; price: number; sources: string[]; title?: string }> = [];
    const mergeRemovals: string[] = [];
    const mergePending: Array<{ bundleId: string; target: 'Active' | 'Ended' }> = [];

    for (const { bundleId } of group) {
      const row = await repos.bundles.findById(bundleId);
      if (!row) continue;
      if (row.status === 'Draft') continue;

      const target = deriveStatus(row.scheduleStart, row.scheduleEnd, now);
      if (target === row.status) continue;

      // Same plan gate the route applies. Leaving it `Scheduled` with a reason
      // is the honest outcome: neither silently live, nor silently ended.
      if (row.operation === 'update' && target === 'Active' && !isPlusPlan(plan)) {
        await repos.bundles.update(bundleId, {
          scheduleError: `Update bundles are not available on this plan. ${planGateReason(plan)}`,
        });
        continue;
      }

      if (row.operation === 'merge' && row.parentVariantId) {
        if (shouldBeLive(target)) {
          const items = await repos.bundleItems.listForBundle(bundleId);
          mergeUpserts.push(
            mergeConfigEntry({
              parentVariantId: row.parentVariantId,
              price: toMajorNumber(row.price, currency),
              items: items.map((i) => ({
                variantId: i.variantId,
                qty: i.qty,
                price: toMajorNumber(i.price, currency),
              })),
              title: row.name,
            }),
          );
        } else {
          mergeRemovals.push(row.parentVariantId);
        }
        mergePending.push({ bundleId, target });
        continue;
      }

      try {
        let metafieldState: 'Written' | 'Cleared' | null = null;
        let metafieldGid: string | null = null;

        if (row.operation === 'expand' && row.parentVariantId) {
          if (shouldBeLive(target)) {
            const items = await repos.bundleItems.listForBundle(bundleId);
            const written = await deps.transports.writeComposition(
              env,
              domain,
              row.parentVariantId,
              items.map((i) => ({
                variantId: i.variantId,
                qty: i.qty,
                price: toMajorNumber(i.price, currency),
              })),
              row.price === null ? null : toMajorNumber(row.price, currency),
            );
            metafieldState = 'Written';
            metafieldGid = written.metafieldGid;
          } else if (row.metafieldState === 'Written') {
            await deps.transports.clearComposition(env, domain, row.parentVariantId);
            metafieldState = 'Cleared';
          }
        }

        // Status LAST, and only once Shopify has agreed.
        await repos.bundles.update(bundleId, { status: target, scheduleError: null });
        if (metafieldState !== null) {
          await repos.bundles.setMetafieldState(bundleId, metafieldState, metafieldGid);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bundleSchedule] bundle ${bundleId} (${domain}) failed to reach ${target}:`, err);
        await repos.bundles.update(bundleId, { scheduleError: message });
      }
    }

    if (mergePending.length > 0) {
      try {
        const { metafieldGid } = await deps.transports.applyMergeBatch(env, domain, {
          upserts: mergeUpserts,
          removeParentVariantIds: mergeRemovals,
        });
        for (const { bundleId, target } of mergePending) {
          await repos.bundles.update(bundleId, { status: target, scheduleError: null });
          await repos.bundles.setMetafieldState(
            bundleId,
            shouldBeLive(target) ? 'Written' : 'Cleared',
            shouldBeLive(target) ? metafieldGid : null,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bundleSchedule] merge batch failed for ${domain}:`, err);
        // The batch is all-or-nothing by construction — one metafield, one
        // write — so every bundle in it keeps its old status and retries.
        for (const { bundleId } of mergePending) {
          await repos.bundles.update(bundleId, { scheduleError: message });
        }
      }
    }
```

Add a local helper beside `groupByShop`:

```ts
/** Minor units -> major units, the unit both metafield transports speak. */
function toMajorNumber(minorUnits: number | null, currency: string): number {
  if (minorUnits === null) {
    throw new Error('[bundleSchedule] a merge bundle reached the cron with no price');
  }
  return Number(toMoney(minorUnits, currency)!.amount);
}
```

and the imports:

```ts
import { applyMergeBatch, clearComposition, mergeConfigEntry, writeComposition } from '../lib/bundleMetafields';
import { toMoney } from '../lib/money';
import { isPlusPlan, planGateReason } from '../lib/shopPlan';
```

- [ ] **Step 4: Implement the production wiring**

Replace the throwing `createBundleScheduleDeps` with:

```ts
export function createBundleScheduleDeps(env: Env): BundleScheduleDeps {
  return {
    scanner: createDueBundleScanner(env.DB),
    shops: createShopRepository(env.DB),
    reposFor: (shopId) => createRepositories(env.DB, shopId),
    getToken: (domain) => getShopAccessToken(domain, env),
    transports: { writeComposition, clearComposition, applyMergeBatch },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lifecycle/bundleSchedule.test.ts`
Expected: PASS — both the Task 6 tests and the new transport tests.

- [ ] **Step 6: Verify the whole suite and types**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle/bundleSchedule.ts src/lifecycle/bundleSchedule.test.ts
git commit -m "feat(schedule): write and clear cart-transform metafields on schedule boundaries"
```

---

## Task 8: Enable the cron trigger

**Files:**
- Modify: `wrangler.jsonc` (the commented `triggers` block at the end)
- Modify: `src/index.ts` (add a `scheduled` export beside `export { app }`)

**Interfaces:**
- Consumes: `runBundleSchedule`, `createBundleScheduleDeps` (Tasks 6-7).
- Produces: the Worker's `scheduled` export.

- [ ] **Step 1: Enable the trigger**

In `wrangler.jsonc`, after the `observability` block, add a real `triggers` key (and remove the `// Cron triggers` comment lines that describe it):

```jsonc
  ,

  // Bundle scheduling — one pass every 5 minutes brings due bundles live and
  // takes expired ones down. See src/lifecycle/bundleSchedule.ts.
  "triggers": { "crons": ["*/5 * * * *"] }
```

Make sure the `observability` object now ends with a comma and the JSON stays valid.

- [ ] **Step 2: Add the scheduled export**

In `src/index.ts`, add the import beside the others:

```ts
import { createBundleScheduleDeps, runBundleSchedule } from './lifecycle/bundleSchedule';
```

and replace the trailing `export default app;` (or whatever the file's current default export is — read the last lines first) with:

```ts
export default {
  fetch: app.fetch,

  /**
   * Bundle scheduling, every 5 minutes (wrangler.jsonc `triggers.crons`).
   *
   * `waitUntil` so a slow Admin call cannot have the pass torn down mid-write,
   * and `controller.scheduledTime` rather than `Date.now()` so every bundle in
   * one pass is judged against the same instant.
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = new Date(controller.scheduledTime).toISOString();
    ctx.waitUntil(
      runBundleSchedule(env, now, createBundleScheduleDeps(env)).catch((err) => {
        console.error('[scheduled] bundle schedule pass failed:', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
```

If `src/index.ts` currently ends with `export default app;`, the `fetch: app.fetch` line above preserves that behaviour. Keep `export { app };` — the integration tests import it.

- [ ] **Step 3: Verify the Worker still builds**

Run: `npm run check`
Expected: PASS — `tsc --noEmit`, the Vite build, and `wrangler deploy --dry-run` all succeed. The dry run is what proves the cron trigger and the `scheduled` export are wired correctly; a malformed `wrangler.jsonc` fails here.

- [ ] **Step 4: Verify the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc src/index.ts
git commit -m "feat(schedule): run the bundle schedule pass every 5 minutes"
```

---

## Task 9: Client-side UTC conversion

**Files:**
- Create: `web/lib/schedule.ts`
- Create: `web/lib/schedule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toUtcIso(date: string, time: string): string` — `'2026-10-03'` + `'09:00'` → UTC ISO
  - `fromUtcIso(iso: string): { date: string; time: string }` — the inverse, in local time
  - `formatWindowLabel(iso: string): string` — e.g. `'Fri 3 Oct 2026, 9:00 am (AEST)'`
  - `localZoneName(): string`

- [ ] **Step 1: Write the failing test**

Create `web/lib/schedule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatWindowLabel, fromUtcIso, toUtcIso } from './schedule';

// These tests are only meaningful in a non-UTC zone: in UTC, a function that
// wrongly parsed the input as UTC would pass every assertion. vitest reads TZ
// from the environment, so this file sets it explicitly.
process.env.TZ = 'Australia/Sydney';

describe('toUtcIso', () => {
  it('treats the entered value as LOCAL wall-clock time, not UTC', () => {
    // 2026-10-03 19:00 in Sydney (AEST, UTC+10) is 09:00Z.
    expect(toUtcIso('2026-10-03', '19:00')).toBe('2026-10-03T09:00:00.000Z');
  });

  it('produces a fixed-width Z-suffixed string, so the server index stays sane', () => {
    expect(toUtcIso('2026-01-05', '07:05')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('throws on an incomplete value rather than emitting an Invalid Date', () => {
    expect(() => toUtcIso('2026-10-03', '')).toThrow();
  });
});

describe('fromUtcIso', () => {
  it('round-trips through toUtcIso', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-10-03', '19:00'));
    expect({ date, time }).toEqual({ date: '2026-10-03', time: '19:00' });
  });

  it('round-trips across a DST transition', () => {
    // Sydney moves to AEDT on 2026-10-04; a naive fixed-offset conversion
    // returns 03:00 here.
    const { date, time } = fromUtcIso(toUtcIso('2026-10-05', '02:00'));
    expect({ date, time }).toEqual({ date: '2026-10-05', time: '02:00' });
  });

  it('zero-pads, so the values drop straight into a date/time input', () => {
    const { date, time } = fromUtcIso(toUtcIso('2026-01-05', '07:05'));
    expect(date).toBe('2026-01-05');
    expect(time).toBe('07:05');
  });
});

describe('formatWindowLabel', () => {
  it('names the local date, time and zone', () => {
    const label = formatWindowLabel('2026-10-03T09:00:00.000Z');
    expect(label).toContain('3 Oct 2026');
    expect(label).toMatch(/7:00\s?pm/i);
    expect(label).toMatch(/AEST|GMT\+10/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/lib/schedule.test.ts`
Expected: FAIL — "Failed to resolve import './schedule'".

- [ ] **Step 3: Write minimal implementation**

Create `web/lib/schedule.ts`:

```ts
/**
 * Local wall-clock ⇄ UTC conversion for the bundle schedule fields.
 *
 * The merchant types a time in THEIR browser's timezone; the server stores UTC.
 * All of that conversion lives here, and only here, so there is one place to
 * test it and one place to change it if we ever switch to the store's timezone.
 */

/**
 * `'2026-10-03'` + `'19:00'` -> the same instant as a UTC ISO string.
 *
 * `new Date('2026-10-03T19:00')` — note: NO trailing Z — parses as local
 * wall-clock time, which is what makes DST the platform's problem rather than
 * ours. Do not "tidy" this into a UTC parse.
 */
export function toUtcIso(date: string, time: string): string {
  const parsed = new Date(`${date}T${time}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`[schedule] not a valid local date and time: ${date} ${time}`);
  }
  return parsed.toISOString();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The inverse of `toUtcIso`, in values a date/time input accepts directly. */
export function fromUtcIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`[schedule] not a valid ISO datetime: ${iso}`);
  }
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** The browser's timezone, e.g. `Australia/Sydney`. */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A human label for a stored UTC instant, naming the zone explicitly.
 *
 * The zone is spelled out because the window is set in the BROWSER's timezone,
 * not the store's — printing it is what keeps that from being invisible to a
 * merchant working from somewhere else.
 */
export function formatWindowLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=Australia/Sydney npx vitest run web/lib/schedule.test.ts`
Expected: PASS. If `formatWindowLabel`'s assertions fail on the exact punctuation Node's ICU emits, adjust the expected substrings to what it actually produces — keep asserting on date, time and zone presence, and do not weaken the test to a bare "is a string".

- [ ] **Step 5: Commit**

```bash
git add web/lib/schedule.ts web/lib/schedule.test.ts
git commit -m "feat(schedule): local wall-clock to UTC conversion for the editor"
```

---

## Task 10: The Schedule card in the editor

**Files:**
- Create: `web/bundles/statusTone.ts`
- Modify: `web/types/bundles.ts` (the `Bundle` interface)
- Modify: `web/bundles/api.ts` (the `BundleInput` interface)
- Modify: `web/Pages/BundleEditor.tsx` (state ~line 204, hydration ~line 226, save ~line 473-496, render)

**Interfaces:**
- Consumes: `toUtcIso`, `fromUtcIso`, `formatWindowLabel` (Task 9); the route's schedule fields (Task 5).
- Produces: `STATUS_TONE: Record<BundleStatus, Tone>` from `web/bundles/statusTone.ts`.

- [ ] **Step 1: Add the status tone map**

Create `web/bundles/statusTone.ts`:

```ts
import type { Tone } from '../types/discounts';
import type { BundleStatus } from '../types/bundles';

/**
 * Badge tone per bundle status. Matches the mapping the E7 campaign spec uses,
 * so a merchant reads the same colours across bundles and campaigns.
 */
export const STATUS_TONE: Record<BundleStatus, Tone> = {
  Active: 'success',
  Scheduled: 'info',
  Ended: 'neutral',
  Draft: 'warning',
};
```

- [ ] **Step 2: Extend the client types**

In `web/types/bundles.ts`, add to `Bundle`:

```ts
  scheduleStart: string | null;
  scheduleEnd: string | null;
  scheduleError: string | null;
```

In `web/bundles/api.ts`, add to `BundleInput`:

```ts
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
```

- [ ] **Step 3: Add the editor state**

In `web/Pages/BundleEditor.tsx`, beside the existing `const [status, setStatus] = useState<BundleStatus>('Active');`, add:

```ts
  // The window is held as the merchant typed it — local date + local time —
  // and converted to UTC only on save. Holding UTC here would mean converting
  // on every keystroke.
  const [hasStart, setHasStart] = useState(false);
  const [hasEnd, setHasEnd] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('23:59');
```

with the import:

```ts
import { formatWindowLabel, fromUtcIso, localZoneName, toUtcIso } from '../lib/schedule';
```

- [ ] **Step 4: Hydrate the state from a loaded bundle**

In the hydration `useEffect`, after `setStatus(bundle.status);`, add:

```ts
    if (bundle.scheduleStart) {
      const { date, time } = fromUtcIso(bundle.scheduleStart);
      setHasStart(true);
      setStartDate(date);
      setStartTime(time);
    }
    if (bundle.scheduleEnd) {
      const { date, time } = fromUtcIso(bundle.scheduleEnd);
      setHasEnd(true);
      setEndDate(date);
      setEndTime(time);
    }
```

- [ ] **Step 5: Derive the preview status and send the window on save**

Add above the component's return, after the existing derived values:

```ts
  // Converted once, and reused by both the preview and the save — so what the
  // merchant is shown is exactly what gets sent.
  let scheduleStart: string | null = null;
  let scheduleEnd: string | null = null;
  let scheduleFieldError: string | null = null;
  try {
    if (hasStart && startDate) scheduleStart = toUtcIso(startDate, startTime);
    if (hasEnd && endDate) scheduleEnd = toUtcIso(endDate, endTime);
    if (scheduleStart && scheduleEnd && scheduleStart >= scheduleEnd) {
      scheduleFieldError = 'The start must be before the end.';
    }
  } catch {
    scheduleFieldError = 'Enter a valid date and time.';
  }

  // Mirrors the server's deriveStatus so the merchant sees `Scheduled` BEFORE
  // saving rather than after. The server still decides; this is a preview.
  const previewStatus: BundleStatus = (() => {
    if (status === 'Draft') return 'Draft';
    const now = new Date().toISOString();
    if (scheduleEnd !== null && now >= scheduleEnd) return 'Ended';
    if (scheduleStart !== null && now < scheduleStart) return 'Scheduled';
    return 'Active';
  })();
```

In both save paths (the create and the update call, around lines 473 and 490), add to the payload object:

```ts
      scheduleStart,
      scheduleEnd,
```

and block the save when the window is invalid — at the top of the save handler:

```ts
    if (scheduleFieldError) {
      setBannerError(scheduleFieldError);
      return;
    }
```

- [ ] **Step 6: Render the Schedule card**

Add this `Card` immediately above the card that holds the status control:

```tsx
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">Schedule</Text>
                  <StatusBadge label={previewStatus} tone={STATUS_TONE[previewStatus]} />
                </InlineStack>

                <Checkbox
                  label="Set a start date"
                  checked={hasStart}
                  onChange={setHasStart}
                  helpText="Leave off to start as soon as the bundle is saved."
                />
                {hasStart && (
                  <InlineGrid columns={2} gap="300">
                    <TextField
                      label="Start date"
                      type="date"
                      value={startDate}
                      onChange={setStartDate}
                      autoComplete="off"
                    />
                    <TextField
                      label="Start time"
                      type="time"
                      value={startTime}
                      onChange={setStartTime}
                      autoComplete="off"
                    />
                  </InlineGrid>
                )}
                {scheduleStart && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Goes live ${formatWindowLabel(scheduleStart)}`}
                  </Text>
                )}

                <Checkbox
                  label="Set an end date"
                  checked={hasEnd}
                  onChange={setHasEnd}
                  helpText="Leave off to run until you switch the bundle off."
                />
                {hasEnd && (
                  <InlineGrid columns={2} gap="300">
                    <TextField
                      label="End date"
                      type="date"
                      value={endDate}
                      onChange={setEndDate}
                      autoComplete="off"
                    />
                    <TextField
                      label="End time"
                      type="time"
                      value={endTime}
                      onChange={setEndTime}
                      autoComplete="off"
                    />
                  </InlineGrid>
                )}
                {scheduleEnd && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Ends ${formatWindowLabel(scheduleEnd)}`}
                  </Text>
                )}

                {scheduleFieldError && (
                  <Banner tone="critical">{scheduleFieldError}</Banner>
                )}

                <Text as="p" variant="bodySm" tone="subdued">
                  {`Times are in your computer’s timezone (${localZoneName()}). The bundle goes live and comes down automatically within 5 minutes of each time.`}
                </Text>

                {bundle?.scheduleError && (
                  <Banner tone="warning" title="The last scheduled change did not go through">
                    <p>{bundle.scheduleError}</p>
                    <p>It will be retried automatically. Saving the bundle also retries it.</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>
```

Add `Checkbox`, `InlineGrid`, `InlineStack` and `Banner` to the `@shopify/polaris` import if they are not already there, and import `StatusBadge` from `../components/StatusBadge`. `STATUS_TONE` comes from `../bundles/statusTone` (Step 1).

- [ ] **Step 7: Verify**

Run: `npm run lint:ci && npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Check it in the real app**

Run: `npm run dev`, open the bundle editor, tick "Set a start date", choose a time an hour from now, and confirm: the badge reads `Scheduled`, the subdued line names your timezone, and saving returns a bundle whose status stays `Scheduled`.

- [ ] **Step 9: Commit**

```bash
git add web/bundles/statusTone.ts web/types/bundles.ts web/bundles/api.ts web/Pages/BundleEditor.tsx
git commit -m "feat(schedule): schedule card in the bundle editor"
```

---

## Task 11: Status and schedule on the bundle list

**Files:**
- Modify: `web/Pages/Bundles.tsx` (headings ~line 156, row cells ~line 174-230)

**Interfaces:**
- Consumes: `Bundle.status`, `Bundle.scheduleStart`, `Bundle.scheduleEnd` and `STATUS_TONE` (Task 10); `formatWindowLabel` (Task 9); `StatusBadge`.
- Produces: no new exports.

- [ ] **Step 1: Add the columns**

In `web/Pages/Bundles.tsx`, add two headings between `{ title: 'Operation' }` and `{ title: 'Price', alignment: 'end' }`:

```tsx
                { title: 'Status' },
                { title: 'Schedule' },
```

and the matching cells, immediately after the operation `IndexTable.Cell`:

```tsx
                    <IndexTable.Cell>
                      <StatusBadge label={b.status} tone={STATUS_TONE[b.status]} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {b.scheduleStart || b.scheduleEnd ? (
                        <BlockStack gap="050">
                          {b.scheduleStart && (
                            <Text as="span" variant="bodySm">
                              {`From ${formatWindowLabel(b.scheduleStart)}`}
                            </Text>
                          )}
                          {b.scheduleEnd && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {`Until ${formatWindowLabel(b.scheduleEnd)}`}
                            </Text>
                          )}
                        </BlockStack>
                      ) : (
                        <Text as="span" tone="subdued">Always on</Text>
                      )}
                    </IndexTable.Cell>
```

with the imports:

```tsx
import { StatusBadge } from '../components/StatusBadge';
import { STATUS_TONE } from '../bundles/statusTone';
import { formatWindowLabel } from '../lib/schedule';
```

- [ ] **Step 2: Verify**

Run: `npm run lint:ci && npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Check it in the real app**

Run: `npm run dev`, open the bundles list, and confirm a scheduled bundle shows an `info` badge and its window in local time, while an unscheduled one reads "Always on".

- [ ] **Step 4: Commit**

```bash
git add web/Pages/Bundles.tsx
git commit -m "feat(schedule): show status and window on the bundle list"
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

All four must pass before the branch is considered done. `npm run check` includes `wrangler deploy --dry-run`, which is what proves the cron trigger and `scheduled` export are wired.

- [ ] **Confirm the cron is registered**

Run: `npx wrangler deploy --dry-run` and confirm the output lists the `*/5 * * * *` schedule. A cron that silently fails to register would leave every scheduled bundle stuck forever, and nothing else in the suite would notice.
