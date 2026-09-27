import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import type { CampaignRow, CampaignBundleRow, CampaignDiscountRow, Repositories } from '../db/repositories';
import { deriveCampaignStatus, type CampaignStatus } from '../lib/campaignStatus';
import { findLockingCampaign } from '../lib/bundleOwnership';
import { assertWindowOrder, normalizeUtc } from '../lib/scheduleWindow';
import { getAdapter, type DiscountEngineType } from '../lib/discountEngines/adapters';
import { createDiscountInShopify } from '../lib/createDiscount';
import { requireShopDomain } from '../lib/shopDomain';

export const campaignRoutes = new Hono<AppEnv>();

/** What a client posts for one discount the campaign authors. */
interface CampaignDiscountInput {
  type: DiscountEngineType;
  method: 'automatic' | 'code';
  /** Required when `method` is 'code'. */
  code?: string;
  /** Required when `method` is 'automatic'; for `code` it defaults to `code`. */
  name?: string;
  /** The merchant's FORM state — see the column comment on `campaignDiscount.configJson`. */
  configJson: unknown;
}

interface CampaignInput {
  name?: string;
  description?: string | null;
  scheduleMode?: 'immediate' | 'window';
  startsAt?: string | null;
  endsAt?: string | null;
  discounts?: CampaignDiscountInput[];
  bundleIds?: string[];
}

interface CampaignDiscountDto {
  id: string;
  name: string;
  type: CampaignDiscountRow['type'];
  method: CampaignDiscountRow['method'];
  code: string | null;
  configJson: string;
  configBytes: number;
  shopifyGid: string | null;
  publishState: CampaignDiscountRow['publishState'];
  publishError: string | null;
}

interface CampaignDto {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  scheduleMode: CampaignRow['scheduleMode'];
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  discounts: CampaignDiscountDto[];
  bundleIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Lets a handler fail with a specific status without every caller re-checking. */
class HttpError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function toDiscountDto(row: CampaignDiscountRow): CampaignDiscountDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    method: row.method,
    code: row.code,
    configJson: row.configJson,
    configBytes: row.configBytes,
    shopifyGid: row.shopifyGid,
    publishState: row.publishState,
    publishError: row.publishError,
  };
}

async function toDto(repos: Repositories, row: CampaignRow): Promise<CampaignDto> {
  const [discounts, bundles] = await Promise.all([
    repos.campaignDiscounts.listForCampaign(row.id),
    repos.campaignBundles.listForCampaign(row.id),
  ]);

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    scheduleMode: row.scheduleMode,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    publishedAt: row.publishedAt,
    discounts: discounts.map(toDiscountDto),
    bundleIds: bundles.map((b) => b.bundleId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Recomputes `status` from the window and, when it differs from the stored
 * value, writes it back — so `?status=` on the list stays useful. The
 * derivation is always the source of truth; the stored column is only a
 * cache of it, refreshed here.
 */
async function withDerivedStatus(
  repos: Repositories,
  row: CampaignRow,
  now: string,
): Promise<CampaignRow> {
  const derived = deriveCampaignStatus(row.status, row.startsAt, row.endsAt, now);
  if (derived === row.status) return row;
  return repos.campaigns.update(row.id, { status: derived });
}

/**
 * Resolves the effective schedule window for a create/update, normalizing to
 * UTC and enforcing ordering exactly as `resolveSchedule` does in
 * `src/routes/bundles.ts`. Throws `HttpError(400)` on a bad value — never
 * returns a null bound for an unparseable input.
 */
function resolveWindow(
  requested: { scheduleMode?: string; startsAt?: string | null; endsAt?: string | null },
  current: { scheduleMode: CampaignRow['scheduleMode']; startsAt: string | null; endsAt: string | null },
): { scheduleMode: CampaignRow['scheduleMode']; startsAt: string | null; endsAt: string | null } {
  const scheduleMode: CampaignRow['scheduleMode'] =
    requested.scheduleMode === 'window' || requested.scheduleMode === 'immediate'
      ? requested.scheduleMode
      : current.scheduleMode;

  const pick = (field: 'startsAt' | 'endsAt'): string | null => {
    const value = requested[field];
    if (value === undefined) return current[field];
    if (value === null) return null;
    try {
      return normalizeUtc(value);
    } catch {
      throw new HttpError(400, `${field} is not a valid date and time.`);
    }
  };

  const startsAt = pick('startsAt');
  const endsAt = pick('endsAt');

  try {
    assertWindowOrder(startsAt, endsAt);
  } catch {
    throw new HttpError(400, 'The campaign start must be before the end.');
  }

  return { scheduleMode, startsAt, endsAt };
}

/**
 * The write boundary's code/title guard (Task 5 ruling #3): a discount whose
 * `method` is 'code' with no non-empty `code`, or 'automatic' with no
 * non-empty title/name, must never reach storage. The shared
 * `createDiscountInShopify` service uses non-null assertions on these at
 * publish time, so a row missing them would crash with a TypeError instead of
 * a clean 400 — rejecting here means no such row can ever be stored.
 *
 * Also computes `configBytes` from the SERIALIZED config (ruling #2) — what
 * `getAdapter(type).sizeBytes(form)` returns, not the byte length of the form
 * JSON itself.
 */
function validateDiscountInput(
  input: CampaignDiscountInput,
): { name: string; code: string | null; configBytes: number } {
  if (input.method !== 'automatic' && input.method !== 'code') {
    throw new HttpError(400, "discount method must be 'automatic' or 'code'");
  }
  if (input.method === 'code' && !input.code?.trim()) {
    throw new HttpError(400, 'code is required for a discount-code promotion');
  }
  if (input.method === 'automatic' && !input.name?.trim()) {
    throw new HttpError(400, 'title is required for an automatic discount');
  }

  const adapter = getAdapter(input.type);
  let configBytes: number;
  try {
    configBytes = adapter.sizeBytes(input.configJson as never);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `Invalid discount configuration: ${message}`);
  }

  return {
    name: input.method === 'code' ? (input.name?.trim() || input.code!.trim()) : input.name!.trim(),
    code: input.method === 'code' ? input.code!.trim() : null,
    configBytes,
  };
}

/**
 * The bundle ownership lock. A bundle already claimed by another campaign
 * that is still `Scheduled`/`Published` cannot be attached — two campaigns
 * authoring one bundle's schedule would mean the last publish silently wins.
 * A bundle whose owner has ENDED is free to reuse; that is the derived lock
 * doing its job.
 */
async function assertBundleAttachable(
  repos: Repositories,
  bundleId: string,
  currentCampaignId: string,
  now: string,
): Promise<void> {
  const bundle = await repos.bundles.findById(bundleId);
  if (!bundle) throw new HttpError(404, `Bundle ${bundleId} not found`);

  // `findLockingCampaign` is shared with the bundle PUT (`src/routes/bundles.ts`)
  // so the two can never disagree about which statuses lock.
  const owner = await findLockingCampaign(repos.campaigns, bundle.campaignId, currentCampaignId, now);
  if (owner) {
    throw new HttpError(
      409,
      `Bundle ${bundleId} is already owned by campaign "${owner.name}" (${owner.status}). `
      + `Remove it from that campaign before attaching it here.`,
    );
  }
}

// GET /api/campaigns — optionally filtered by `?status=`, DERIVED per row.
campaignRoutes.get('/api/campaigns', async (c) => {
  const repos = c.get('repos');
  const statusFilter = c.req.query('status') as CampaignStatus | undefined;
  const now = new Date().toISOString();

  const rows = await repos.campaigns.listByStatus();
  const derived = await Promise.all(rows.map((row) => withDerivedStatus(repos, row, now)));
  const filtered = statusFilter ? derived.filter((row) => row.status === statusFilter) : derived;

  const campaigns = await Promise.all(filtered.map((row) => toDto(repos, row)));
  return c.json({ campaigns });
});

// GET /api/campaigns/:id — 404 when missing, status DERIVED.
campaignRoutes.get('/api/campaigns/:id', async (c) => {
  const repos = c.get('repos');
  const id = c.req.param('id');
  const now = new Date().toISOString();

  const row = await repos.campaigns.findById(id);
  if (!row) return c.json({ error: 'Campaign not found' }, 404);

  const current = await withDerivedStatus(repos, row, now);
  return c.json({ campaign: await toDto(repos, current) });
});

// POST /api/campaigns — creates a Draft. `name` is required.
campaignRoutes.post('/api/campaigns', async (c) => {
  const body = await c.req.json<CampaignInput>().catch(() => ({}) as CampaignInput);

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  let window: ReturnType<typeof resolveWindow>;
  try {
    window = resolveWindow(body, { scheduleMode: 'immediate', startsAt: null, endsAt: null });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const repos = c.get('repos');
  const row = await repos.campaigns.create({
    name: body.name.trim(),
    description: body.description ?? null,
    status: 'Draft',
    scheduleMode: window.scheduleMode,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    publishedAt: null,
  });

  return c.json({ campaign: await toDto(repos, row) }, 201);
});

/** 409s unless the campaign's DERIVED status is `Draft` — the merchant's own edit window. */
async function assertEditable(
  repos: Repositories,
  row: CampaignRow,
  now: string,
): Promise<CampaignRow> {
  const current = await withDerivedStatus(repos, row, now);
  if (current.status !== 'Draft') {
    throw new HttpError(
      409,
      `Campaign "${current.name}" is ${current.status} and can no longer be edited.`,
    );
  }
  return current;
}

// PUT /api/campaigns/:id — 404 when missing, 409 unless still Draft.
campaignRoutes.put('/api/campaigns/:id', async (c) => {
  const repos = c.get('repos');
  const id = c.req.param('id');
  const now = new Date().toISOString();

  const existing = await repos.campaigns.findById(id);
  if (!existing) return c.json({ error: 'Campaign not found' }, 404);

  let current: CampaignRow;
  try {
    current = await assertEditable(repos, existing, now);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const body = await c.req.json<CampaignInput>().catch(() => ({}) as CampaignInput);

  if (body.name !== undefined && !body.name.trim()) {
    return c.json({ error: 'name cannot be empty' }, 400);
  }

  let window: ReturnType<typeof resolveWindow>;
  let discounts: Array<{ input: CampaignDiscountInput; validated: ReturnType<typeof validateDiscountInput> }> = [];
  try {
    window = resolveWindow(body, {
      scheduleMode: current.scheduleMode,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
    });

    if (body.discounts !== undefined) {
      if (!Array.isArray(body.discounts)) {
        throw new HttpError(400, 'discounts must be an array');
      }
      discounts = body.discounts.map((input) => ({ input, validated: validateDiscountInput(input) }));
    }

    if (body.bundleIds !== undefined) {
      if (!Array.isArray(body.bundleIds)) {
        throw new HttpError(400, 'bundleIds must be an array');
      }
      for (const bundleId of body.bundleIds) {
        await assertBundleAttachable(repos, bundleId, id, now);
      }
    }
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const patch: Partial<CampaignRow> = {
    scheduleMode: window.scheduleMode,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description;

  const merged = await repos.campaigns.update(id, patch);

  if (body.discounts !== undefined) {
    await repos.campaignDiscounts.deleteForCampaign(id);
    for (const { input, validated } of discounts) {
      await repos.campaignDiscounts.create({
        name: validated.name,
        type: input.type,
        method: input.method,
        code: validated.code,
        configJson: JSON.stringify(input.configJson),
        configBytes: validated.configBytes,
        shopifyGid: null,
        publishState: 'pending',
        publishError: null,
        campaignId: id,
      });
    }
  }

  if (body.bundleIds !== undefined) {
    await repos.campaignBundles.deleteForCampaign(id);
    for (const bundleId of body.bundleIds) {
      await repos.campaignBundles.create({ campaignId: id, bundleId });
    }
  }

  return c.json({ campaign: await toDto(repos, merged) });
});

// DELETE /api/campaigns/:id — 404 when missing, 409 unless still Draft.
campaignRoutes.delete('/api/campaigns/:id', async (c) => {
  const repos = c.get('repos');
  const id = c.req.param('id');
  const now = new Date().toISOString();

  const existing = await repos.campaigns.findById(id);
  if (!existing) return c.json({ error: 'Campaign not found' }, 404);

  try {
    await assertEditable(repos, existing, now);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  // Explicit cleanup of the join tables rather than relying solely on the
  // cascading FK — see the class comment on the repositories for why each
  // exists as its own method.
  await repos.campaignDiscounts.deleteForCampaign(id);
  await repos.campaignBundles.deleteForCampaign(id);
  await repos.campaigns.delete(id);

  return c.json({ ok: true });
});

// POST /api/campaigns/:id/publish — stamps the campaign's window onto every
// member: each discount is created in Shopify with that window as its own
// startsAt/endsAt, and each bundle gets the same two timestamps in
// scheduleStart/scheduleEnd for the existing cron to pick up. Both halves
// carry the SAME two timestamps, so they fire together by construction.
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

  // CLAIM the campaign before ANY Shopify work. Everything above this line is
  // a read or a 4xx, so claiming here costs a rejected request nothing; from
  // here on a second concurrent handler must lose. The derived gate above is
  // still the one that produces the good message for an already-Published or
  // Ended campaign — this is the race the gate cannot close on its own,
  // because it reads a status that only gets written back after every Admin
  // round-trip. If the claim is lost, this request has created nothing and
  // simply stops.
  const claimed = await repos.campaigns.claimForPublish(id);
  if (!claimed) {
    return c.json({ error: 'This campaign is already being published. Reload to see the result.' }, 409);
  }

  const shopDomain = requireShopDomain(c);
  let created = 0;
  let failed = 0;
  // Bundle problems are reported separately from discount `failed` — a
  // stolen/missing bundle leaves nothing on any row a UI could read back
  // (unlike a discount, which always gets a `publishError` on its own row),
  // so each one is named here instead of folding it into one opaque count.
  const bundleFailures: Array<{ bundleId: string; error: string }> = [];

  for (const cd of discounts) {
    // Sequential on purpose: each create is its own Admin call and a failure
    // must not abandon the rest. The whole body is also wrapped: a THROW here
    // (malformed configJson, a missing code/title, an adapter throw not
    // caught by the service) must not escape either — discounts already
    // created above exist in Shopify, and the campaign status write below
    // must still be reached so a retry is refused by the 409 gate rather than
    // duplicating them.
    try {
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
        // Counted the moment Shopify confirms the create — nothing that
        // happens afterwards may undo this. The discount now exists whether
        // or not the bookkeeping write below succeeds.
        created += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          await repos.campaignDiscounts.setPublishResult(cd.id, {
            shopifyGid: outcome.discountId, publishState: 'created', publishError: null,
          });
        } catch {
          // The discount is live in Shopify regardless of whether this
          // bookkeeping write landed. There is nothing more this request can
          // do about a D1 failure here, and — critically — this must NOT
          // reclassify the row as failed: doing so could send `created` back
          // to 0 and trip the revert-to-Draft branch below with a live
          // discount outstanding, which is the exact duplication hazard this
          // whole route exists to prevent, just wearing a different hat.
        }
      } else {
        failed += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          await repos.campaignDiscounts.setPublishResult(cd.id, {
            shopifyGid: null, publishState: 'failed', publishError: outcome.error,
          });
        } catch {
          // Best-effort bookkeeping; nothing was created in Shopify for this
          // row, so there is no duplication risk in leaving it un-recorded.
        }
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      try {
        // eslint-disable-next-line no-await-in-loop
        await repos.campaignDiscounts.setPublishResult(cd.id, {
          shopifyGid: null, publishState: 'failed', publishError: message,
        });
      } catch {
        // Same as above — best-effort only.
      }
    }
  }

  // Stamping a bundle is only safe once the DISCOUNT outcome is known. A
  // campaign whose every discount failed goes back to `Draft` below, and a
  // bundle stamped before that decision would be left `Scheduled` on the
  // campaign's window with a Draft campaign behind it: the cron activates it
  // on the boundary, the merchant never published it, and — a Draft campaign
  // not locking — a second campaign can claim it. Skipping the loop entirely
  // is the unwind: a bundle that was never stamped needs no walking back.
  const discountsFullyFailed = created === 0 && failed > 0;

  // Bundles are not written to Shopify here. Stamping the window and the owner
  // is the whole job: the existing cron activates them on the boundary exactly
  // as it does a merchant-scheduled bundle.
  const bundlesToStamp = discountsFullyFailed ? [] : bundles;
  let bundlesStamped = 0;
  for (const cb of bundlesToStamp) {
    // `campaignId` is written only HERE, at publish — not when a bundle is
    // attached to a Draft — so the same bundle can sit in two Drafts and the
    // lock has to be re-checked at the one moment it's about to be spent.
    // A bundle a different still-locking campaign already owns is skipped
    // and recorded as a failure rather than stolen; a thrown NotFoundError
    // (bundle deleted meanwhile) is handled the same way. Either way this
    // must not abort the loop or the campaign's status write below.
    try {
      // eslint-disable-next-line no-await-in-loop
      await assertBundleAttachable(repos, cb.bundleId, id, now);
      // eslint-disable-next-line no-await-in-loop
      await repos.bundles.update(cb.bundleId, {
        scheduleStart: startsAt, scheduleEnd: endsAt, campaignId: id, status: 'Scheduled',
      });
      bundlesStamped += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bundleFailures.push({ bundleId: cb.bundleId, error: message });
    }
  }

  // A campaign that put NOTHING live carries no risk from a retry — there is
  // nothing in Shopify to duplicate and no bundle stamped onto this window —
  // so it goes back to Draft rather than being stranded as "published" with
  // nothing published, whose only escape would be cloning. The moment anything
  // HAS gone live, the invariant above takes over: the status write must land
  // regardless of any other failure, so this branch only fires when nothing
  // succeeded.
  //
  // BUNDLES COUNT AS MEMBERS HERE. A bundles-only campaign whose every bundle
  // was skipped created nothing, scheduled nothing and owns nothing — writing
  // it `Published` would leave a campaign with zero members that PUT, DELETE
  // and republish all refuse, while the only honest thing to tell the merchant
  // is "nothing went live, fix it and try again". That sentence is only true
  // if the stored status agrees, so the two are decided together.
  //
  // This is also what releases the claim taken above: reverting to `Draft`
  // makes the campaign claimable again.
  const fullyFailed = created === 0 && bundlesStamped === 0;
  const published = fullyFailed ? 'Draft' : deriveCampaignStatus('Scheduled', startsAt, endsAt, now);
  await repos.campaigns.update(
    id,
    fullyFailed
      ? { status: 'Draft' }
      : { status: published, publishedAt: now, startsAt, endsAt },
  );

  return c.json({ status: published, created, failed, bundleFailures });
});

// POST /api/campaigns/:id/clone — the only edit path for a non-Draft
// campaign, since PUT/DELETE both 409 on anything past Draft. Allowed from
// ANY source status, including Draft itself: cloning is a read of the source
// plus inserts, so it cannot damage the source whatever state it is in, and
// gating it would be an arbitrary restriction on a merchant who just wants a
// second similar campaign. The source campaign and its rows are never
// written to — only read.
campaignRoutes.post('/api/campaigns/:id/clone', async (c) => {
  const repos = c.get('repos');
  const id = c.req.param('id');

  const source = await repos.campaigns.findById(id);
  if (!source) return c.json({ error: 'Campaign not found' }, 404);

  const [discounts, bundles] = await Promise.all([
    repos.campaignDiscounts.listForCampaign(id),
    repos.campaignBundles.listForCampaign(id),
  ]);

  const clone = await repos.campaigns.create({
    name: `${source.name} (copy)`,
    description: source.description,
    status: 'Draft',
    scheduleMode: source.scheduleMode,
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    publishedAt: null,
  });

  for (const cd of discounts) {
    // Sequential on purpose — see the `no-await-in-loop` convention used
    // elsewhere in this file for repeated sequential writes.
    // eslint-disable-next-line no-await-in-loop
    await repos.campaignDiscounts.create({
      name: cd.name,
      type: cd.type,
      method: cd.method,
      code: cd.code,
      configJson: cd.configJson,
      configBytes: cd.configBytes,
      // The one invariant this route exists to protect: a carried-over gid
      // would make the clone point at the SOURCE's live Shopify discount.
      shopifyGid: null,
      publishState: 'pending',
      publishError: null,
      campaignId: clone.id,
    });
  }

  for (const cb of bundles) {
    // eslint-disable-next-line no-await-in-loop
    await repos.campaignBundles.create({ campaignId: clone.id, bundleId: cb.bundleId });
  }

  return c.json({ campaignId: clone.id });
});
