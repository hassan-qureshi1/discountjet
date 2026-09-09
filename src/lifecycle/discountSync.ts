import { and, eq, isNull } from 'drizzle-orm';
import type { createDb } from '../db/db';
import { discount, webhookEvent } from '../db/schema';
import type { Env } from '../types/env';
import { adminGraphql, type GraphqlResult } from '../lib/graphqlAdmin';

type Db = ReturnType<typeof createDb>;

export type DiscountKind = 'tier' | 'bundle' | 'special';
export type DiscountMethod = 'automatic' | 'code';
export type DiscountStatus = 'active' | 'inactive';

// The three engine functions each write a JSON config under their own reserved
// `$app:` namespace. Presence of one of these on a discount node is what marks
// the discount as owned by THIS app.
const CONFIG_NAMESPACES: Record<DiscountKind, string> = {
  tier: '$app:discount-tier',
  bundle: '$app:discount-bundle',
  special: '$app:discount-special',
};

// Minimal shape of a `discounts/*` webhook payload.
export interface DiscountWebhookPayload {
  admin_graphql_api_id?: string;
  id?: number | string;
  title?: string;
  updated_at?: string;
  created_at?: string;
}

interface HydratedNode {
  discount: {
    __typename: string;
    title?: string;
    status?: string; // ACTIVE | SCHEDULED | EXPIRED
    updatedAt?: string;
    createdAt?: string;
  } | null;
  tier?: { value: string } | null;
  bundle?: { value: string } | null;
  special?: { value: string } | null;
}

interface HydrateResponse {
  discountNode: HydratedNode | null;
}

const HYDRATE_QUERY = `#graphql
  query HydrateDiscountNode($id: ID!) {
    discountNode(id: $id) {
      discount {
        __typename
        ... on DiscountAutomaticApp { title status updatedAt: updatedAt createdAt }
        ... on DiscountCodeApp { title status updatedAt: updatedAt createdAt }
        ... on DiscountAutomaticBasic { title status updatedAt: updatedAt createdAt }
        ... on DiscountCodeBasic { title status updatedAt: updatedAt createdAt }
        ... on DiscountAutomaticBxgy { title status updatedAt: updatedAt createdAt }
        ... on DiscountCodeBxgy { title status updatedAt: updatedAt createdAt }
        ... on DiscountAutomaticFreeShipping { title status updatedAt: updatedAt createdAt }
        ... on DiscountCodeFreeShipping { title status updatedAt: updatedAt createdAt }
      }
      tier: metafield(namespace: "${CONFIG_NAMESPACES.tier}", key: "config") { value }
      bundle: metafield(namespace: "${CONFIG_NAMESPACES.bundle}", key: "config") { value }
      special: metafield(namespace: "${CONFIG_NAMESPACES.special}", key: "config") { value }
    }
  }`;

// ─── Pure classification / mapping helpers (unit-tested) ──────────────────────

/** Shopify discount node `__typename` → discount method. */
export function mapMethod(typename: string): DiscountMethod | null {
  if (typename.startsWith('DiscountAutomatic')) return 'automatic';
  if (typename.startsWith('DiscountCode')) return 'code';
  return null;
}

/** Shopify `DiscountStatus` (ACTIVE | SCHEDULED | EXPIRED) → binary list status. */
export function mapStatus(shopifyStatus: string | undefined): DiscountStatus {
  return shopifyStatus === 'ACTIVE' ? 'active' : 'inactive';
}

/** Which engine config metafield is present, and its parsed JSON, or null. */
export function kindAndConfig(
  node: HydratedNode,
): { kind: DiscountKind; config: Record<string, unknown> } | null {
  for (const kind of Object.keys(CONFIG_NAMESPACES) as DiscountKind[]) {
    const raw = node[kind]?.value;
    if (raw) {
      try {
        const config = JSON.parse(raw) as Record<string, unknown>;
        return { kind, config };
      } catch {
        return { kind, config: {} };
      }
    }
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function collectIds(source: unknown, into: Set<string>): void {
  if (Array.isArray(source)) {
    for (const v of source) {
      if (typeof v === 'number' || typeof v === 'string') into.add(String(v));
      else collectIds(v, into);
    }
  } else if (isRecord(source)) {
    for (const [key, v] of Object.entries(source)) {
      // Only count target-selection arrays, not every numeric field.
      if (/target_variants|target_product_ids|targets\b/.test(key)) collectIds(v, into);
      else if (Array.isArray(v) || isRecord(v)) collectIds(v, into);
    }
  }
}

/** Best-effort count of distinct targeted variants/products in a config. */
export function countProducts(kind: DiscountKind, config: Record<string, unknown>): number {
  const ids = new Set<string>();
  if (kind === 'tier') {
    const tiers = config.discount_tiers;
    if (isRecord(tiers)) for (const entry of Object.values(tiers)) collectIds(entry, ids);
  } else if (kind === 'bundle') {
    collectIds(config.bundle_discounts, ids);
  } else {
    collectIds(config.special_discounts, ids);
  }
  return ids.size;
}

export interface Classification {
  isAppOwned: boolean;
  name: string;
  method: DiscountMethod | null;
  status: DiscountStatus;
  type: DiscountKind | null;
  products: number;
  updatedAt: string | null;
  createdAt: string | null;
}

/** Classify a hydrated node into the fields we mirror. Non-app nodes → isAppOwned:false. */
export function classifyNode(node: HydratedNode, fallbackName = ''): Classification {
  const d = node.discount;
  const owned = kindAndConfig(node);
  return {
    isAppOwned: owned !== null,
    name: d?.title ?? fallbackName,
    method: d ? mapMethod(d.__typename) : null,
    status: mapStatus(d?.status),
    type: owned?.kind ?? null,
    products: owned ? countProducts(owned.kind, owned.config) : 0,
    updatedAt: d?.updatedAt ?? null,
    createdAt: d?.createdAt ?? null,
  };
}

/** Mirrored gids no longer present in the live Shopify set → to be tombstoned. */
export function gidsToTombstone(existingGids: string[], liveGids: Set<string>): string[] {
  return existingGids.filter((gid) => !liveGids.has(gid));
}

// ─── DB-driven webhook sync ───────────────────────────────────────────────────

export interface SyncDeps {
  db: Db;
  env: Env;
  shopId: string;
  shopDomain: string;
  topic: string;
  deliveryId: string;
  payload: DiscountWebhookPayload;
}

export type SyncOutcome =
  | { result: 'skipped_duplicate' }
  | { result: 'native' }
  | { result: 'tombstoned' }
  | { result: 'ignored_stale' }
  | { result: 'upserted'; id: string };

/** True if this delivery id has not been seen before (records it if new). */
async function recordDelivery(deps: SyncDeps, shopifyGid: string | null): Promise<boolean> {
  const existing = await deps.db
    .select({ id: webhookEvent.id })
    .from(webhookEvent)
    .where(eq(webhookEvent.id, deps.deliveryId))
    .get();
  if (existing) return false;
  await deps.db.insert(webhookEvent).values({
    id: deps.deliveryId,
    topic: deps.topic,
    shopId: deps.shopId,
    shopifyGid,
    receivedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Handle one `discounts/{create,update,delete}` webhook: gate on idempotency,
 * then tombstone (delete) or hydrate+classify+upsert (create/update). Only
 * app-owned discounts are mirrored; native ones are recorded as an event only.
 */
export async function syncDiscountFromWebhook(deps: SyncDeps): Promise<SyncOutcome> {
  const shopifyGid = deps.payload.admin_graphql_api_id ?? null;

  const isNew = await recordDelivery(deps, shopifyGid);
  if (!isNew) return { result: 'skipped_duplicate' };

  if (!shopifyGid) return { result: 'native' };

  // Delete: tombstone by GID (delete always wins, regardless of timestamp).
  if (deps.topic === 'discounts/delete') {
    await deps.db
      .update(discount)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(discount.shopId, deps.shopId), eq(discount.shopifyGid, shopifyGid)));
    return { result: 'tombstoned' };
  }

  // Create / update: hydrate the node to learn ownership, method, status, config.
  const res = await adminGraphql<HydrateResponse>(deps.shopDomain, deps.env, HYDRATE_QUERY, {
    id: shopifyGid,
  });
  const node = res.data?.discountNode;
  if (!node) return { result: 'native' };

  const c = classifyNode(node, deps.payload.title ?? '');
  if (!c.isAppOwned) return { result: 'native' };

  return upsertClassified(deps.db, deps.shopId, shopifyGid, c, {
    updatedAt: deps.payload.updated_at,
    createdAt: deps.payload.created_at,
  });
}

/**
 * Insert or update the mirror row for one classified app-owned discount, applying
 * the `updated_at` ordering guard. Shared by the webhook path and backfill/reconcile
 * so mapping never diverges. A create/update also clears any prior tombstone.
 */
async function upsertClassified(
  db: Db,
  shopId: string,
  shopifyGid: string,
  c: Classification,
  fallback: { updatedAt?: string; createdAt?: string } = {},
): Promise<SyncOutcome> {
  const incomingUpdatedAt = c.updatedAt ?? fallback.updatedAt ?? new Date().toISOString();

  const existing = await db
    .select({ id: discount.id, updatedAt: discount.updatedAt })
    .from(discount)
    .where(and(eq(discount.shopId, shopId), eq(discount.shopifyGid, shopifyGid)))
    .get();

  if (existing) {
    // Ordering guard: ignore a delivery older than what we already stored.
    if (existing.updatedAt && incomingUpdatedAt < existing.updatedAt) {
      return { result: 'ignored_stale' };
    }
    await db
      .update(discount)
      .set({
        name: c.name,
        type: c.type,
        method: c.method,
        status: c.status,
        products: c.products,
        deletedAt: null, // a fresh create/update un-tombstones
        updatedAt: incomingUpdatedAt,
      })
      .where(eq(discount.id, existing.id));
    return { result: 'upserted', id: existing.id };
  }

  const id = crypto.randomUUID();
  await db.insert(discount).values({
    id,
    shopId,
    shopifyGid,
    name: c.name,
    type: c.type,
    method: c.method,
    status: c.status,
    products: c.products,
    createdAt: c.createdAt ?? fallback.createdAt ?? incomingUpdatedAt,
    updatedAt: incomingUpdatedAt,
  });
  return { result: 'upserted', id };
}

// ─── Backfill / reconcile / sync-health (E4-5) ────────────────────────────────

export interface SyncContext {
  db: Db;
  env: Env;
  shopId: string;
  shopDomain: string;
}

// Reconcile records itself in webhook_event under this synthetic topic so the
// sync-health read can report the last reconcile time without a new column.
const RECONCILE_TOPIC = 'app/reconcile';

interface BackfillResponse {
  discountNodes: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<HydratedNode & { id: string }>;
  };
}

const BACKFILL_QUERY = `#graphql
  query BackfillDiscounts($first: Int!, $after: String) {
    discountNodes(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticApp { title status updatedAt createdAt }
          ... on DiscountCodeApp { title status updatedAt createdAt }
          ... on DiscountAutomaticBasic { title status updatedAt createdAt }
          ... on DiscountCodeBasic { title status updatedAt createdAt }
          ... on DiscountAutomaticBxgy { title status updatedAt createdAt }
          ... on DiscountCodeBxgy { title status updatedAt createdAt }
          ... on DiscountAutomaticFreeShipping { title status updatedAt createdAt }
          ... on DiscountCodeFreeShipping { title status updatedAt createdAt }
        }
        tier: metafield(namespace: "${CONFIG_NAMESPACES.tier}", key: "config") { value }
        bundle: metafield(namespace: "${CONFIG_NAMESPACES.bundle}", key: "config") { value }
        special: metafield(namespace: "${CONFIG_NAMESPACES.special}", key: "config") { value }
      }
    }
  }`;

/**
 * Paginate every discount node, upsert app-owned rows through the shared classify
 * core, and return the set of all live gids (used by reconcile to detect deletes).
 */
export async function backfillDiscounts(ctx: SyncContext): Promise<{ liveGids: Set<string>; upserted: number }> {
  const liveGids = new Set<string>();
  let upserted = 0;
  let after: string | null = null;

  // Hard page cap so a pathological store can't loop forever.
  for (let page = 0; page < 100; page++) {
    const res: GraphqlResult<BackfillResponse> = await adminGraphql<BackfillResponse>(
      ctx.shopDomain,
      ctx.env,
      BACKFILL_QUERY,
      { first: 100, after },
    );
    const conn = res.data?.discountNodes;
    if (!conn) break;

    for (const node of conn.nodes) {
      liveGids.add(node.id);
      const c = classifyNode(node);
      if (!c.isAppOwned) continue; // native discounts are not mirrored
      const outcome = await upsertClassified(ctx.db, ctx.shopId, node.id, c);
      if (outcome.result === 'upserted') upserted++;
    }

    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  return { liveGids, upserted };
}

/**
 * Backfill, then tombstone any mirrored row whose gid is no longer live in Shopify
 * (deleted while a webhook was missed). Idempotent: a run with no Shopify changes
 * upserts the same rows and tombstones nothing new. Records a reconcile event.
 */
export async function reconcileDiscounts(ctx: SyncContext): Promise<{ upserted: number; tombstoned: number }> {
  const { liveGids, upserted } = await backfillDiscounts(ctx);

  const rows = await ctx.db
    .select({ shopifyGid: discount.shopifyGid })
    .from(discount)
    .where(and(eq(discount.shopId, ctx.shopId), isNull(discount.deletedAt)))
    .all();

  const now = new Date().toISOString();
  const stale = gidsToTombstone(
    rows.map((r) => r.shopifyGid),
    liveGids,
  );
  for (const gid of stale) {
    await ctx.db
      .update(discount)
      .set({ deletedAt: now })
      .where(and(eq(discount.shopId, ctx.shopId), eq(discount.shopifyGid, gid)));
  }

  await ctx.db.insert(webhookEvent).values({
    id: crypto.randomUUID(),
    topic: RECONCILE_TOPIC,
    shopId: ctx.shopId,
    shopifyGid: null,
    receivedAt: now,
  });

  return { upserted, tombstoned: stale.length };
}

export interface SyncHealth {
  lastWebhookAt: string | null;
  lastReconcileAt: string | null;
  unknownCount: number;
}

/**
 * Sync-health signal (consumed by E12): the most recent discount webhook, the last
 * reconcile, and the number of mirrored rows still missing their engine type
 * (config metafield not yet seen).
 */
export async function getSyncHealth(db: Db, shopId: string): Promise<SyncHealth> {
  const events = await db
    .select({ topic: webhookEvent.topic, receivedAt: webhookEvent.receivedAt })
    .from(webhookEvent)
    .where(eq(webhookEvent.shopId, shopId))
    .all();

  let lastWebhookAt: string | null = null;
  let lastReconcileAt: string | null = null;
  for (const e of events) {
    if (e.topic === RECONCILE_TOPIC) {
      if (!lastReconcileAt || e.receivedAt > lastReconcileAt) lastReconcileAt = e.receivedAt;
    } else if (!lastWebhookAt || e.receivedAt > lastWebhookAt) {
      lastWebhookAt = e.receivedAt;
    }
  }

  const unknown = await db
    .select({ id: discount.id })
    .from(discount)
    .where(and(eq(discount.shopId, shopId), isNull(discount.deletedAt), isNull(discount.type)))
    .all();

  return { lastWebhookAt, lastReconcileAt, unknownCount: unknown.length };
}
