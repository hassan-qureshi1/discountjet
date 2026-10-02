# Sequential Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bundle can belong to many campaigns as long as their windows do not overlap, so November's sale and December's sale can both be set up today on the same bundles and each takes over in turn.

**Architecture:** Bundle ownership stops being *stamped* at publish and becomes *derived* from campaign windows each cron pass — matching how campaign status, the ownership lock and the sale state are already derived. Publish refuses only a genuine window overlap. The existing capture machinery is untouched: `pre_sale_price`, capture-before-write and restore-before-clear all stay exactly as they are.

**Tech Stack:** Cloudflare Workers, Hono, D1 + Drizzle, Vitest, React 18 + Shopify Polaris 13.

**Spec:** `docs/superpowers/specs/2026-10-02-sequential-campaigns-design.md`

## Global Constraints

- All D1 access goes through a repository — no `createDb()` or Drizzle query builder outside `src/db/repositories/`. Routes use `c.get('repos')`; the cron uses `reposFor(shopId)`. Every custom predicate composes through `this.scope(...)`.
- All `/api/*` routes stay behind `requireShop`; `PUBLIC_API_PATHS` untouched.
- Fail loudly — no `?? ''` or fallback masking a missing window, id or price.
- Return `null`, never `undefined`, for a miss.
- Money stays minor units as `integer`; timestamps stay normalized UTC ISO-8601 strings compared as strings.
- `web/` ESLint forbids `for...of` and `continue`.
- **The capture machinery is out of scope and must not change.** `pre_sale_price` is still captured before the Shopify write, cleared only after a confirmed restore, and released only when the parent variant no longer exists. Any task that finds itself editing that logic has misread its brief.

**Two rules from the spec that bind every task:**

- **No gap is enforced between campaigns.** A merchant may set back-to-back windows. `decideSaleAction` returns `none` while a capture is outstanding, so the next campaign waits a pass rather than capturing the previous one's *sale* price as the original. That five-minute lateness is the correct trade and must not be optimised away.
- **Overlap is refused at publish, not when dates are typed.** A Draft is a working document and may legitimately be half-built.

## Review Focus

Five failure modes the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **A null `endsAt` means "runs forever"**, so it overlaps everything after its start. Treating null as "no constraint" would let a second campaign publish straight through an unbounded one. (Task 1)
2. **Two campaigns whose windows merely touch** — one ends exactly when the next begins — must NOT count as overlapping, or every sensible back-to-back schedule is refused. (Task 1)
3. **A campaign deleted mid-queue** must hand its bundles to the next queued campaign rather than leaving them owned by a campaign that no longer exists. (Task 5)
4. **A cron pass that straddles a handover** — campaign A's window closed and B's opened since the last pass — must restore A before B can capture, or B records A's sale price as the original and a real price is lost forever. (Task 5)
5. **Publishing a campaign whose window is already current** onto a free bundle must stamp it immediately, not wait for the next pass — otherwise an "immediate" campaign appears to do nothing for five minutes. (Task 4)

---

## File Structure

**Create:**
- `src/lib/windowOverlap.ts` (+ test) — pure interval maths. No I/O, so the rule that decides whether a merchant is refused is exhaustively testable.

**Modify:**
- `src/db/repositories/CampaignBundleRepository.ts` — a scoped lookup from a bundle to the campaigns holding it.
- `src/routes/campaigns.ts` — overlap validation at publish; stamp only when current; drop the selection-time guard.
- `src/lifecycle/bundleSchedule.ts` — resolve the owner from windows, and hand a bundle on.
- `web/campaigns/steps/BundlesStep.tsx` — selection allowed; the owner badge becomes informational.

---

## Task 1: `windowOverlap` — the rule, as pure maths

**Files:**
- Create: `src/lib/windowOverlap.ts`, `src/lib/windowOverlap.test.ts`

**Interfaces:**
- Produces:
  - `interface Window { startsAt: string | null; endsAt: string | null }`
  - `windowsOverlap(a: Window, b: Window): boolean`

Windows are half-open: `[start, end)`. Two of them overlap when `aStart < bEnd && bStart < aEnd`. A null end is "runs forever"; a null start is "already started". Timestamps are normalized UTC ISO-8601 and compare correctly as strings, which is how the rest of this codebase compares them.

- [ ] **Step 1: Write the failing test**

Create `src/lib/windowOverlap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { windowsOverlap } from './windowOverlap';

const w = (startsAt: string | null, endsAt: string | null) => ({ startsAt, endsAt });

const NOV = w('2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z');
const DEC = w('2026-12-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z');

describe('windowsOverlap', () => {
  it('separates two windows that do not meet', () => {
    expect(windowsOverlap(NOV, DEC)).toBe(false);
  });

  it('is symmetric', () => {
    expect(windowsOverlap(DEC, NOV)).toBe(windowsOverlap(NOV, DEC));
  });

  it('finds a genuine overlap', () => {
    expect(windowsOverlap(NOV, w('2026-11-15T00:00:00.000Z', '2026-12-15T00:00:00.000Z'))).toBe(true);
  });

  it('counts one window wholly inside another', () => {
    expect(windowsOverlap(NOV, w('2026-11-10T00:00:00.000Z', '2026-11-20T00:00:00.000Z'))).toBe(true);
  });

  // Review Focus #2 — the case that makes sequential scheduling usable at all.
  it('does NOT count windows that merely touch', () => {
    // November ends at the instant December begins. Refusing this would reject
    // every sensible back-to-back schedule a merchant writes.
    const touching = w('2026-11-30T00:00:00.000Z', '2026-12-20T00:00:00.000Z');

    expect(windowsOverlap(NOV, touching)).toBe(false);
  });

  // Review Focus #1 — the dangerous reading of null.
  it('treats a null end as running forever, so it overlaps everything after its start', () => {
    const unbounded = w('2026-11-01T00:00:00.000Z', null);

    expect(windowsOverlap(unbounded, DEC)).toBe(true);
    // Reading null as "no constraint" would return false here and let a second
    // campaign publish straight through an unbounded one.
  });

  it('treats a null end as NOT reaching backwards before its start', () => {
    const unbounded = w('2026-12-01T00:00:00.000Z', null);

    expect(windowsOverlap(NOV, unbounded)).toBe(false);
  });

  it('treats a null start as already running', () => {
    const alwaysOn = w(null, '2026-11-15T00:00:00.000Z');

    expect(windowsOverlap(alwaysOn, NOV)).toBe(true);
    expect(windowsOverlap(alwaysOn, DEC)).toBe(false);
  });

  it('counts two unbounded windows as overlapping', () => {
    expect(windowsOverlap(w(null, null), w(null, null))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/windowOverlap.test.ts`
Expected: FAIL — cannot resolve `./windowOverlap`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Whether two campaign windows collide.
 *
 * Pure, because this is the rule that decides whether a merchant is refused at
 * publish, and it should be provable without a database or a clock.
 *
 * Windows are half-open — `[start, end)` — which is what makes sequential
 * scheduling usable: a campaign ending at the exact instant the next begins
 * does NOT overlap it, so a merchant can write back-to-back dates the obvious
 * way. Timestamps are normalized UTC ISO-8601 and compare correctly as
 * strings, the same way the due-scan compares them.
 */
export interface Window {
  startsAt: string | null;
  endsAt: string | null;
}

/** Sentinels, so the comparison below needs no null branches. */
const BEGINNING = '';
const FOREVER = '￿';

export function windowsOverlap(a: Window, b: Window): boolean {
  // A null start is "already running", a null end is "runs forever". The
  // second matters most: reading null as "no constraint" would make an
  // unbounded campaign overlap NOTHING, and a second campaign could publish
  // straight through it.
  const aStart = a.startsAt ?? BEGINNING;
  const aEnd = a.endsAt ?? FOREVER;
  const bStart = b.startsAt ?? BEGINNING;
  const bEnd = b.endsAt ?? FOREVER;

  return aStart < bEnd && bStart < aEnd;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/windowOverlap.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/windowOverlap.ts src/lib/windowOverlap.test.ts
git commit -m "feat(campaigns): decide whether two campaign windows collide"
```

---

## Task 2: Look up the campaigns holding a bundle

**Files:**
- Modify: `src/db/repositories/CampaignBundleRepository.ts`, `src/db/repositories/inMemory.ts`
- Test: `src/db/repositories/CampaignRepository.test.ts`

**Interfaces:**
- Produces: `ICampaignBundleRepository.listCampaignIdsForBundle(bundleId: string): Promise<string[]>`

Both the overlap check and the ownership resolution need the same question answered — which campaigns hold this bundle — so it is one method, added once.

- [ ] **Step 1: Write the failing test**

Append to `src/db/repositories/CampaignRepository.test.ts`, following the SQL-asserting idiom already in that file:

```ts
describe('CampaignBundleRepository.listCampaignIdsForBundle', () => {
  it('scopes the lookup by shop as well as bundle', async () => {
    const { fake, campaignBundles } = repos();
    await campaignBundles.listCampaignIdsForBundle('b1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"bundle_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('b1');
  });

  it('returns ids, not rows, and never undefined for a miss', async () => {
    const { campaignBundles } = repos([]);
    await expect(campaignBundles.listCampaignIdsForBundle('nope')).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/CampaignRepository.test.ts -t listCampaignIdsForBundle`
Expected: FAIL — `listCampaignIdsForBundle is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/db/repositories/CampaignBundleRepository.ts`, add to the interface and the class:

```ts
  /**
   * Which campaigns hold this bundle, by id.
   *
   * Asked by two callers for the same reason — the publish-time overlap check
   * and the cron's ownership resolution both need to know who else wants this
   * bundle — so it exists once rather than as two similar queries.
   */
  async listCampaignIdsForBundle(bundleId: string): Promise<string[]> {
    const rows = await this.db
      .select({ campaignId: campaignBundle.campaignId })
      .from(campaignBundle)
      .where(this.scope(eq(campaignBundle.bundleId, bundleId)))
      .all();
    return rows.map((r) => r.campaignId);
  }
```

Add the matching fake to `src/db/repositories/inMemory.ts`, filtering on `bundleId` **and** `inScope`, mirroring the real scoping. A fake laxer than the real repository turns a tenant-isolation bug into a passing test.

- [ ] **Step 4: Run the whole suite**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories
git commit -m "feat(campaigns): look up the campaigns holding a bundle"
```

---

## Task 3: Allow selecting a bundle another campaign holds

**Files:**
- Modify: `src/routes/campaigns.ts` (the `PUT` call to `assertBundleAttachable`, around line 351), `web/campaigns/steps/BundlesStep.tsx`, `src/api.integration.test.ts`

**Interfaces:**
- Consumes: nothing new.

A Draft that merely lists a bundle writes nothing to that bundle, so there is nothing to conflict with. The publish-time call stays untouched — it is the one path that writes.

- [ ] **Step 1: Write the failing test**

In `src/api.integration.test.ts`, replace the existing test that asserts a 409 on attaching an owned bundle. That test pins the behaviour being deliberately removed, so it is rewritten rather than deleted — the same fixture now expects success:

```ts
  it('lets a Draft select a bundle another campaign owns, because a Draft writes nothing to it', async () => {
    seed({
      campaigns: [
        campaignRow({ id: 'live', status: 'Published', scheduleMode: 'immediate' }),
        campaignRow({ id: 'draft', status: 'Draft', scheduleMode: 'immediate' }),
      ],
      bundles: [bundleRow({ id: 'b1', campaignId: 'live' })],
    });

    const res = await app.request('/api/campaigns/draft', {
      method: 'PUT',
      headers: { 'x-shop-domain': 'mystore.myshopify.com', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleIds: ['b1'] }),
    }, env('development'));

    // Planning next month's campaign while this month's runs is ordinary. The
    // refusal belongs at publish, which is where the window is written.
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api.integration.test.ts -t "because a Draft writes nothing"`
Expected: FAIL with 409.

- [ ] **Step 3: Remove the selection-time guard**

In the campaign `PUT` handler, delete the loop that calls `assertBundleAttachable` for each incoming `bundleId`. Leave the publish-time call exactly as it is, and replace the removed code with a comment saying why selection is now free and where the real refusal lives.

- [ ] **Step 4: Make the badge informational**

In `web/campaigns/steps/BundlesStep.tsx`, stop `ownerLocks` contributing to `disabled`, so a row owned by another campaign can be ticked. Keep the `StatusBadge` naming the owner — the merchant should still see who else holds it — and change its tone from the locked styling to an informational one. The plan gate and the `canVerifyLocks` failure case still disable rows; only the ownership clause goes.

- [ ] **Step 5: Verify**

Run: `npm run lint:ci && npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/campaigns.ts web/campaigns/steps/BundlesStep.tsx src/api.integration.test.ts
git commit -m "feat(campaigns): let a Draft select a bundle another campaign holds"
```

---

## Task 4: Refuse an overlapping publish, and stamp only when current

**Files:**
- Modify: `src/routes/campaigns.ts` (publish), `src/api.integration.test.ts`

**Interfaces:**
- Consumes: `windowsOverlap` (Task 1), `listCampaignIdsForBundle` (Task 2), `deriveCampaignStatus` and `isCampaignLocking` from `src/lib/campaignStatus.ts`.

Two changes in one task because they are one decision: whether this campaign may have the bundle now, and whether it takes it now.

- [ ] **Step 1: Write the failing tests**

```ts
  it('refuses to publish a campaign whose window overlaps another holding the same bundle', async () => {
    seed({
      campaigns: [
        campaignRow({
          id: 'nov', name: 'November', status: 'Published', scheduleMode: 'window',
          startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-30T00:00:00.000Z',
        }),
        campaignRow({
          id: 'clash', status: 'Draft', scheduleMode: 'window',
          startsAt: '2026-11-15T00:00:00.000Z', endsAt: '2026-12-15T00:00:00.000Z',
        }),
      ],
      bundles: [bundleRow({ id: 'b1', name: 'Weekend Away Set' })],
      campaignBundles: [
        campaignBundleRow({ id: 'cb1', campaignId: 'nov', bundleId: 'b1' }),
        campaignBundleRow({ id: 'cb2', campaignId: 'clash', bundleId: 'b1' }),
      ],
    });

    const res = await publish('clash');

    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    // Both halves named: with several campaigns a merchant cannot otherwise
    // tell which pair to fix.
    expect(error).toContain('Weekend Away Set');
    expect(error).toContain('November');
  });

  it('publishes a campaign queued AFTER another on the same bundle', async () => {
    const repos = seed({
      campaigns: [
        campaignRow({
          id: 'nov', status: 'Published', scheduleMode: 'window',
          startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-30T00:00:00.000Z',
        }),
        campaignRow({
          id: 'dec', status: 'Draft', scheduleMode: 'window',
          startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z',
        }),
      ],
      bundles: [bundleRow({ id: 'b1', campaignId: 'nov', scheduleEnd: '2026-11-30T00:00:00.000Z' })],
      campaignBundles: [
        campaignBundleRow({ id: 'cb1', campaignId: 'nov', bundleId: 'b1' }),
        campaignBundleRow({ id: 'cb2', campaignId: 'dec', bundleId: 'b1' }),
      ],
    });

    const res = await publish('dec');

    expect(res.status).toBe(200);
    // December must NOT have taken the bundle: November is still running it,
    // and overwriting its window is the failure this whole design prevents.
    expect(repos.bundles.rows[0]).toMatchObject({ campaignId: 'nov' });
  });

  // Review Focus #5 — an immediate campaign must not appear to do nothing.
  it('stamps a free bundle immediately when the publishing campaign is already current', async () => {
    const repos = seed({
      campaigns: [campaignRow({
        id: 'now', status: 'Draft', scheduleMode: 'window',
        startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
      })],
      bundles: [bundleRow({ id: 'b1', campaignId: null })],
      campaignBundles: [campaignBundleRow({ id: 'cb1', campaignId: 'now', bundleId: 'b1' })],
    });

    const res = await publish('now');

    expect(res.status).toBe(200);
    expect(repos.bundles.rows[0]).toMatchObject({ campaignId: 'now' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api.integration.test.ts -t "overlaps another holding"`
Expected: FAIL — publish currently stamps unconditionally and runs no overlap check.

- [ ] **Step 3: Add the overlap check**

In the publish handler, after the window is resolved and **before** the atomic claim, gather the campaigns sharing each of this campaign's bundles via `listCampaignIdsForBundle`, skip this campaign's own id, load each and derive its status, and refuse with **409** when one is `Scheduled` or `Published` (`isCampaignLocking`) and `windowsOverlap` says the windows collide. The message names the bundle and the campaign:

```
`${bundleName} is already in "${other.name}" (${otherStatus}), whose window overlaps this one. Change this campaign's dates, or remove that bundle.`
```

Running before the claim matters: a refusal must leave the campaign a Draft, not a claimed one.

- [ ] **Step 4: Stamp only when this campaign's window is current**

Replace the unconditional `repos.bundles.update(...)` in the bundle loop with a stamp that happens only when this campaign's own window contains `now` — `deriveCampaignStatus(...)` for the publishing campaign is `Published`. When it is `Scheduled`, leave the bundle untouched and count it as queued rather than stamped; the cron takes it over at the boundary. The existing `assertBundleAttachable` call stays in front of the stamp, unchanged, as the last line of defence.

- [ ] **Step 5: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/campaigns.ts src/api.integration.test.ts
git commit -m "feat(campaigns): refuse an overlapping publish, stamp only when current"
```

---

## Task 5: Resolve the owner each pass, and hand a bundle on

**Files:**
- Modify: `src/lifecycle/bundleSchedule.ts`, `src/lifecycle/bundleSchedule.test.ts`

**Interfaces:**
- Consumes: `listCampaignIdsForBundle` (Task 2); `deriveCampaignStatus` from `src/lib/campaignStatus.ts`.

This is the task that makes a queue work, and the one that touches the restore path. **Read the spec's "What must keep working" section before changing anything.**

- [ ] **Step 1: Write the failing tests**

Add to `src/lifecycle/bundleSchedule.test.ts`, using the file's existing `harness`, `bundleRow`, `shop` and `pricingTransports` helpers, and remembering the real signature is `runBundleSchedule(ENV, NOW, deps)` with rows read back via `reposFor('shop-a').bundles.findById(...)`:

```ts
// Review Focus #3 — a campaign deleted mid-queue must not strand its bundles.
it('hands a bundle to the next queued campaign when its owner is gone', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, campaignId: null, status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('shop-a')],
    t,
  );
  // A campaign whose window is current and which holds this bundle.
  h.seedCampaign({ id: 'next', status: 'Published', startsAt: PAST, endsAt: FUTURE }, ['b1']);

  await runBundleSchedule(ENV, NOW, h.deps);

  const row = (await h.reposFor('shop-a').bundles.findById('b1'))!;
  expect(row.campaignId).toBe('next');
  expect(row.scheduleEnd).toBe(FUTURE);
});

// Review Focus #4 — the handover must never let B capture A's sale price.
it('does not let the next campaign capture while the previous capture is outstanding', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, preSalePrice: 310000, campaignId: 'nov', status: 'Active',
      scheduleStart: PAST, scheduleEnd: PAST,
    })],
    [shop('shop-a')],
    t,
  );
  h.seedCampaign({ id: 'dec', status: 'Published', startsAt: PAST, endsAt: FUTURE }, ['b1']);

  await runBundleSchedule(ENV, NOW, h.deps);

  // The capture is November's real price. December must not record the SALE
  // price as the original, so this pass restores and the next one applies.
  expect(t.setVariantPricing).toHaveBeenCalledWith(
    ENV, 'shop-a.myshopify.com', PARENT,
    expect.objectContaining({ priceMinor: 310000 }),
  );
  expect((await h.reposFor('shop-a').bundles.findById('b1'))!.preSalePrice).toBeNull();
});

it('leaves a bundle alone while its current owner is still running', async () => {
  const t = pricingTransports();
  const h = harness(
    [bundleRow({
      id: 'b1', shopId: 'shop-a', operation: 'expand', parentVariantId: PARENT,
      price: 279000, campaignId: 'nov', status: 'Active',
      scheduleStart: PAST, scheduleEnd: FUTURE,
    })],
    [shop('shop-a')],
    t,
  );
  h.seedCampaign({ id: 'nov', status: 'Published', startsAt: PAST, endsAt: FUTURE }, ['b1']);
  h.seedCampaign({ id: 'dec', status: 'Scheduled', startsAt: FUTURE, endsAt: null }, ['b1']);

  await runBundleSchedule(ENV, NOW, h.deps);

  // December is queued, not owed anything yet.
  expect((await h.reposFor('shop-a').bundles.findById('b1'))!.campaignId).toBe('nov');
});
```

`h.seedCampaign(campaign, bundleIds)` does not exist yet — add it to the file's `harness` so a test can place a campaign and its `campaign_bundle` rows into the in-memory repositories. Keep it minimal: it exists to express these three cases, not as a general fixture API.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lifecycle/bundleSchedule.test.ts -t "hands a bundle"`
Expected: FAIL — the cron reads `bundle.campaignId` and never consults campaign windows.

- [ ] **Step 3: Resolve the owner**

In the per-bundle body, before `decideSaleAction`, determine which campaign should own this bundle **now**: look up its campaign ids, load each, derive each status, and pick the one whose window contains `now` (status `Published`). When that differs from `row.campaignId`, re-stamp `campaignId`, `scheduleStart` and `scheduleEnd` from the new owner before the sale decision runs, so `saleLive` and `decideSaleAction` see the window actually in force.

When no campaign's window contains `now`, leave `campaignId` as it is. The sweep already restores a bundle holding a capture whose `saleLive` is false, and that path must keep working unchanged — a bundle with a capture and no owner at all is exactly the deleted-campaign case the sweep exists for.

- [ ] **Step 4: Verify the capture machinery is untouched**

Run: `git diff src/lifecycle/bundleSchedule.ts` and confirm no hunk changes the capture, the Shopify write ordering, the rollback-free failure path, or the variant-gone release. If one does, the change has gone further than this task.

Run: `npm run type-check && npx vitest run`
Expected: PASS, including every pre-existing sale-pricing test unchanged. Those tests are the proof this task did not disturb the restore guarantee — if one needs editing, stop and work out why.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/bundleSchedule.ts src/lifecycle/bundleSchedule.test.ts
git commit -m "feat(campaigns): resolve bundle ownership from campaign windows"
```

---

## Task 6: Rename the column's meaning

**Files:**
- Modify: `src/db/schema.ts`, `docs/erd.dbml`

**Interfaces:**
- Consumes: nothing. This task changes comments only — no column is renamed, no migration is generated.

The spec's open question: `bundle.campaign_id` no longer means "who published this" but "who owns it right now". The name stays — renaming a column mid-feature is churn — but the comment must say what it now means, or the next reader will trust a stamp that is really a cache.

- [ ] **Step 1: Correct the schema comment**

In `src/db/schema.ts`, rewrite the `bundle.campaignId` comment to say: set at publish only when the campaign's window is already current, otherwise written by the schedule pass when the window arrives; it is the campaign that owns the bundle **now**, re-derived each pass from campaign windows, and therefore a cache of that derivation rather than a durable claim. Note that `pre_sale_price`, not this column, is what makes a sale restorable.

- [ ] **Step 2: Mirror it in the ERD**

Update the `bundle.campaign_id` note in `docs/erd.dbml` to match, keeping the existing `ON DELETE SET NULL` annotation.

- [ ] **Step 3: Verify**

Run: `npm run type-check && npx vitest run`
Expected: PASS — comments only.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts docs/erd.dbml
git commit -m "docs(bundles): campaign_id is who owns the bundle now, not who published it"
```

---

## Final verification

- [ ] **Run everything**

```bash
npm run type-check && npm run lint:ci && npx vitest run && npm run check
```

- [ ] **Confirm a queue in D1**

```bash
npx wrangler d1 execute cloudflare-shopify-starter-db --local --command "
  SELECT b.name AS bundle, b.campaign_id AS owner_now, b.schedule_start, b.schedule_end,
         (SELECT COUNT(*) FROM campaign_bundle cb WHERE cb.bundle_id = b.id) AS in_campaigns
  FROM bundle b WHERE b.campaign_id IS NOT NULL;"
```

Expected: a bundle in two campaigns shows `in_campaigns = 2` with `owner_now` naming only the one whose window is current, and `schedule_start`/`schedule_end` matching that campaign's window.

- [ ] **Manual check against the real store**

This is the part no test covers. With `npm run dev`: publish a campaign over a bundle with a window starting a few minutes out and ending shortly after; publish a second campaign over the same bundle with a window starting after the first ends. Confirm the second publish is accepted. Run `npm run cron` after the first window opens and confirm the bundle carries the first campaign's window; after it closes, run the cron twice and confirm the original price is restored and then the second campaign takes the bundle over.

The two cron runs are the point: the handover deliberately takes two passes, because the second campaign cannot capture while the first's capture is outstanding. Seeing it take two is the behaviour working, not a bug.

If the app cannot be started here, say so plainly rather than claiming it was checked.
