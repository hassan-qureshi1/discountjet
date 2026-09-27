import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import type { CampaignRow, CampaignBundleRow, CampaignDiscountRow, Repositories } from '../db/repositories';
import { deriveCampaignStatus, isCampaignLocking, type CampaignStatus } from '../lib/campaignStatus';
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
  if (!bundle.campaignId || bundle.campaignId === currentCampaignId) return;

  const owner = await repos.campaigns.findById(bundle.campaignId);
  if (!owner) return; // Dangling reference — nothing left to lock against.

  const ownerStatus = deriveCampaignStatus(owner.status, owner.startsAt, owner.endsAt, now);
  if (isCampaignLocking(ownerStatus)) {
    throw new HttpError(
      409,
      `Bundle ${bundleId} is already owned by campaign "${owner.name}" (${ownerStatus}). `
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
