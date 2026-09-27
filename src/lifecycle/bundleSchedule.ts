import {
  createDueBundleScanner,
  createRepositories,
  createShopRepository,
} from '../db/repositories';
import type { DueBundle, IDueBundleScanner, IShopRepository, Repositories } from '../db/repositories';
import { getShopAccessToken } from '../lib/getShopAccessToken';
import {
  applyMergeBatch,
  clearComposition,
  mergeConfigEntry,
  toVariantGid,
  writeComposition,
} from '../lib/bundleMetafields';
import type { MergeBundleConfig } from '../lib/bundleMetafields';
import { toMoney } from '../lib/money';
import { deriveStatus, shouldBeLive } from '../lib/scheduleWindow';
import { isPlusPlan, planGateReason } from '../lib/shopPlan';
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

/**
 * Minor units -> major units, the unit both metafield transports speak.
 *
 * Loud on both halves of the conversion. A missing price is not zero: a bundle
 * that reaches the cron without one would otherwise be published at 0.00. A
 * missing currency is not USD either — guessing it would send a JPY shop's
 * 1000-yen bundle to Shopify as 10.00, priced a hundredfold wrong at checkout.
 * Both throws land in the per-bundle catch, so they become a `scheduleError`
 * on that one row rather than a status the Admin API never agreed to.
 */
function toMajorNumber(minorUnits: number | null, currency: string | null): number {
  if (minorUnits === null) {
    throw new Error('[bundleSchedule] a bundle reached the cron with no price');
  }
  if (!currency) {
    throw new Error('[bundleSchedule] the shop row has no currency; cannot convert prices');
  }
  return Number(toMoney(minorUnits, currency)!.amount);
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

    const currency = shop.currency ?? null;
    const plan = shop.planName ?? shop.plan ?? null;

    // Merge bundles share ONE shop-level metafield, so their changes are
    // collected across the whole group and applied in a single
    // read-modify-write. N separate calls would each clobber the last.
    // Per-variant `expand` changes are independent and go one at a time.
    const mergeUpserts: MergeBundleConfig[] = [];
    const mergeRemovals: string[] = [];
    const mergePending: Array<{ bundleId: string; target: 'Active' | 'Ended' | 'Scheduled' }> = [];

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
        // The same plan gate the route applies. Leaving it `Scheduled` with a
        // reason is the honest outcome: neither silently live, nor silently
        // ended.
        if (row.operation === 'update' && target === 'Active' && !isPlusPlan(plan)) {
          await repos.bundles.update(bundleId, {
            scheduleError: `Update bundles are not available on this plan. ${planGateReason(plan)}`,
          });
          continue;
        }

        if (row.operation === 'merge') {
          if (!row.parentVariantId) {
            throw new Error(`[bundleSchedule] merge bundle ${bundleId} has no parent variant`);
          }
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
            // Normalised the same way `mergeConfigEntry` normalises an upsert:
            // `applyMergeBatch` matches removals against the stored entries by
            // exact string, so a bare variant id here would fail to match the
            // GID the activation wrote and leave the sale live past its window.
            mergeRemovals.push(toVariantGid(row.parentVariantId));
          }
          // Planned, not applied: the batch below decides its fate, so nothing
          // is persisted for it here.
          mergePending.push({ bundleId, target });
          continue;
        }

        let metafieldState: 'Written' | 'Cleared' | null = null;
        let metafieldGid: string | null = null;

        if (row.operation === 'expand') {
          if (!row.parentVariantId) {
            throw new Error(`[bundleSchedule] expand bundle ${bundleId} has no parent variant`);
          }
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

        // Shopify has agreed, so record the transport bookkeeping BEFORE the
        // status, and the status LAST. Between the two writes a concurrent
        // read sees the old status with the new `metafieldState`, which is the
        // conservative pairing: a reader deciding whether a clear is owed sees
        // `Written` and clears, where the reverse order would briefly show
        // `Active` with `NotYet` and let a later end-transition skip the clear
        // — a sale left live after its window closed.
        if (metafieldState !== null) {
          await repos.bundles.setMetafieldState(bundleId, metafieldState, metafieldGid);
        }
        await repos.bundles.update(bundleId, { status: target, scheduleError: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bundleSchedule] bundle ${bundleId} (${domain}) failed to reach ${target}:`, err);
        // Status deliberately untouched: a bundle is never `Active` with
        // nothing written at checkout. One broken bundle does not stop the pass.
        await repos.bundles.update(bundleId, { scheduleError: message });
      }
    }

    if (mergePending.length > 0) {
      // Only the Admin call is inside this try. A D1 failure while persisting
      // must NOT be read as a batch failure: Shopify has already agreed, and
      // stamping `scheduleError` on rows whose status did persist would leave a
      // merchant-visible warning on a bundle that is fine — one the next pass
      // never clears, because `target === row.status` makes it a no-op.
      let batch: { metafieldGid: string | null } | null = null;
      try {
        batch = await deps.transports.applyMergeBatch(env, domain, {
          upserts: mergeUpserts,
          removeParentVariantIds: mergeRemovals,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bundleSchedule] merge batch failed for ${domain}:`, err);
        // The batch is all-or-nothing by construction — one metafield, one
        // write — and nothing was persisted for these rows before it, so every
        // bundle in it keeps its old status and retries next pass.
        for (const { bundleId } of mergePending) {
          await repos.bundles.update(bundleId, { scheduleError: message });
        }
      }

      if (batch !== null) {
        for (const { bundleId, target } of mergePending) {
          const live = shouldBeLive(target);
          try {
            await repos.bundles.setMetafieldState(
              bundleId,
              live ? 'Written' : 'Cleared',
              live ? batch.metafieldGid : null,
            );
            await repos.bundles.update(bundleId, { status: target, scheduleError: null });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[bundleSchedule] bundle ${bundleId} (${domain}) failed to persist ${target}:`, err);
            // Per row, so one bad write does not report failure on the rows
            // beside it. The metafield is already live and the writes are
            // idempotent, so the next pass simply redoes this one.
            try {
              await repos.bundles.update(bundleId, { scheduleError: message });
            } catch (nested) {
              // The error write is the thing failing; there is nowhere left to
              // record it, and the remaining rows still deserve their status.
              console.error(`[bundleSchedule] could not record the failure for ${bundleId}:`, nested);
            }
          }
        }
      }
    }
  }
}
