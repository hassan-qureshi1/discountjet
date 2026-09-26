import {
  createDueBundleScanner,
  createRepositories,
  createShopRepository,
} from '../db/repositories';
import type { DueBundle, IDueBundleScanner, IShopRepository, Repositories } from '../db/repositories';
import { getShopAccessToken } from '../lib/getShopAccessToken';
import { applyMergeBatch, clearComposition, writeComposition } from '../lib/bundleMetafields';
import { deriveStatus } from '../lib/scheduleWindow';
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
  return {
    scanner: createDueBundleScanner(env.DB),
    shops: createShopRepository(env.DB),
    reposFor: (shopId) => createRepositories(env.DB, shopId),
    getToken: (domain) => getShopAccessToken(domain, env),
    transports: { writeComposition, clearComposition, applyMergeBatch },
  };
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
