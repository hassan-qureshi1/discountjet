import {
  createDueBundleScanner,
  createRepositories,
  createShopRepository,
} from '../db/repositories';
import type {
  CampaignRow,
  DueBundle,
  IDueBundleScanner,
  IShopRepository,
  Repositories,
} from '../db/repositories';
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
import { decideSaleAction } from '../lib/salePrice';
import { readVariantPrice, setVariantPricing } from '../lib/variantPricing';
import { deriveStatus, shouldBeLive } from '../lib/scheduleWindow';
import { deriveCampaignStatus } from '../lib/campaignStatus';
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
  readVariantPrice(
    env: Env,
    shopDomain: string,
    variantGid: string,
  ): Promise<{ priceMinor: number; currencyCode: string } | null>;
  setVariantPricing(
    env: Env,
    shopDomain: string,
    variantGid: string,
    values: { priceMinor: number; compareAtMinor: number; currencyCode: string },
  ): Promise<void>;
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
    transports: {
      writeComposition,
      clearComposition,
      applyMergeBatch,
      readVariantPrice,
      setVariantPricing,
    },
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

/**
 * Which campaign owns this bundle RIGHT NOW, or null when none does.
 *
 * Several campaigns may hold the same bundle, queued one after another, so
 * ownership cannot be a stamp written days ahead — it is whichever of them has
 * a window containing `now`. Everything else in this feature is derived the
 * same way (campaign status from its window, the sale state from the capture),
 * and deriving is what makes a queue work with nothing to go stale.
 *
 * Null is the ordinary answer between campaigns, and it means "leave
 * `bundle.campaign_id` alone": the restore sweep is driven by the capture, not
 * by ownership, so a bundle whose campaign ended — or was deleted — still hands
 * the merchant's price back.
 */
async function resolveCurrentOwner(
  repos: Repositories,
  bundleId: string,
  incumbentId: string | null,
  now: string,
): Promise<CampaignRow | null> {
  const campaignIds = await repos.campaignBundles.listCampaignIdsForBundle(bundleId);
  if (campaignIds.length === 0) return null;

  const current: CampaignRow[] = [];
  for (const campaignId of campaignIds) {
    // eslint-disable-next-line no-await-in-loop
    const campaign = await repos.campaigns.findById(campaignId);
    // A link row outliving its campaign is not possible through the FK, but a
    // miss is a legitimately-absent row rather than corrupt state, so it is
    // skipped rather than thrown over.
    if (campaign === null) continue;
    const status = deriveCampaignStatus(campaign.status, campaign.startsAt, campaign.endsAt, now);
    if (status === 'Published') current.push(campaign);
  }

  if (current.length === 0) return null;
  if (current.length === 1) return current[0]!;

  // Publish refuses overlapping windows on a shared bundle, so two current
  // owners means that gate was bypassed or the dates were edited underneath it.
  // The incumbent keeps the bundle — passing it back and forth every five
  // minutes would be far worse than picking wrong once — and failing that the
  // tie breaks on id, so at least the choice is the same on every pass.
  console.error(
    `[bundleSchedule] bundle ${bundleId} is claimed by ${current.length} campaigns whose windows all contain now: ${current.map((c) => c.id).join(', ')}`,
  );
  const incumbent = current.find((c) => c.id === incumbentId);
  if (incumbent) return incumbent;
  return [...current].sort((a, b) => a.id.localeCompare(b.id))[0]!;
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

      // OWNERSHIP, RESOLVED RATHER THAN READ.
      //
      // Before the window is looked at, work out which campaign's window
      // contains `now` and, if it is not the one stamped on the row, hand the
      // bundle over: `campaignId` and the window come from the new owner, and
      // the status goes back to `Scheduled` so the NEXT pass activates it
      // through the ordinary path.
      //
      // `Draft` is the merchant's manual off-switch, so a handover is never
      // forced onto one. `row` is a copy, so updating it in step with the
      // write below just keeps the rest of this iteration reading what was
      // persisted.
      let handover = false;
      if (row.status !== 'Draft') {
        // eslint-disable-next-line no-await-in-loop
        const owner = await resolveCurrentOwner(repos, bundleId, row.campaignId, now);
        if (owner !== null && owner.id !== row.campaignId) {
          // eslint-disable-next-line no-await-in-loop
          await repos.bundles.update(bundleId, {
            campaignId: owner.id,
            scheduleStart: owner.startsAt,
            scheduleEnd: owner.endsAt,
            status: 'Scheduled',
          });
          row.campaignId = owner.id;
          row.scheduleStart = owner.startsAt;
          row.scheduleEnd = owner.endsAt;
          row.status = 'Scheduled';
          handover = true;
        }
      }

      // The scanner's `to` was advisory. This is the decision: a window
      // entirely in the past derives `Ended` even though the activation scan
      // found it, so it never spends a pass live.
      //
      // `Draft` is the merchant's manual off-switch and is never scheduled
      // over, so it has no transition at all — but its SALE state is still
      // `Ended`, which is what the restore below reads.
      const target =
        row.status === 'Draft'
          ? ('Ended' as const)
          : deriveStatus(row.scheduleStart, row.scheduleEnd, now);
      // A HANDOVER PASS NEITHER ACTIVATES NOR APPLIES. It only re-stamps (done
      // above) and restores (below), and the incoming campaign's sale starts on
      // the NEXT pass.
      //
      // That is not a missing optimisation, it is the whole safety of a queue.
      // The outgoing campaign's capture is the merchant's real price, and it is
      // still outstanding at the instant the boundary is crossed. If this pass
      // also applied, `decideSaleAction` would see `onSale` and return `none` —
      // so the new sale would never be applied at all, and worse, a later pass
      // that did apply would read the OLD sale price as live and record THAT as
      // the original. Restoring first and applying next pass costs one cron
      // interval and loses nothing.
      //
      // Skipping the transition as well is what makes that second pass happen:
      // `Scheduled` with a start already past is exactly what the due-scan
      // looks for, whereas writing `Active` here would leave a bundle that is
      // live, not on sale, and no longer due.
      const transitions = !handover && row.status !== 'Draft' && target !== row.status;

      // WHETHER THIS BUNDLE SHOULD BE PRICED ON SALE RIGHT NOW.
      //
      // Narrower than `shouldBeLive(target)` on two counts, both of which are
      // about not borrowing a price we cannot give back or were never asked to
      // borrow:
      //
      //  - `scheduleEnd !== null` — we only overwrite a merchant's price when
      //    we know when to hand it back. A sale with no end is not a sale, it
      //    is a permanent repricing, and that is the merchant's change to make
      //    rather than ours to make irreversibly on their behalf. (An
      //    `immediate` campaign stamps a null end onto its bundles, and that
      //    is the DEFAULT publish path.) The bundle still activates normally;
      //    only the price overwrite is skipped.
      //  - `campaignId !== null` — sale pricing is a campaign feature. A
      //    standalone scheduled expand bundle has no campaign lock, no banner
      //    and no warning in the editor, so repricing its product would be a
      //    surprise. It keeps composition-metafield-only behaviour.
      //  - `!handover` — see the note on `transitions` above: on the pass that
      //    changes hands, the previous owner's capture is restored and the new
      //    owner's sale waits for the next one.
      const saleLive =
        !handover
        && row.operation === 'expand'
        && row.status !== 'Draft'
        && shouldBeLive(target)
        && row.campaignId !== null
        && row.scheduleEnd !== null;

      // A row still holding a capture is looked at EVEN IF nothing about its
      // window is due. That is what the scanner's third query feeds: the
      // capture is the merchant's real price, and a row that should no longer
      // be on sale must be restored no matter which edit took it out of the
      // window.
      const owesRestore = row.preSalePrice !== null && !saleLive;
      if (!transitions && !owesRestore) continue;

      // Fetched at most ONCE per bundle: the composition write and the sale
      // decision both need the components.
      let itemsCache: Awaited<ReturnType<typeof repos.bundleItems.listForBundle>> | null = null;
      const loadItems = async () => {
        if (itemsCache === null) itemsCache = await repos.bundleItems.listForBundle(bundleId);
        return itemsCache;
      };

      try {
        // The same plan gate the route applies. Leaving it `Scheduled` with a
        // reason is the honest outcome: neither silently live, nor silently
        // ended.
        if (transitions && row.operation === 'update' && target === 'Active' && !isPlusPlan(plan)) {
          await repos.bundles.update(bundleId, {
            scheduleError: `Update bundles are not available on this plan. ${planGateReason(plan)}`,
          });
          continue;
        }

        if (row.operation === 'merge' && transitions) {
          if (!row.parentVariantId) {
            throw new Error(`[bundleSchedule] merge bundle ${bundleId} has no parent variant`);
          }
          if (shouldBeLive(target)) {
            const items = await loadItems();
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
          // is persisted for it here. A merge row that somehow still holds a
          // capture keeps it for now; it no longer transitions after this
          // pass, so the safety-net scan hands it back and the restore below
          // runs then.
          mergePending.push({ bundleId, target });
          continue;
        }

        let metafieldState: 'Written' | 'Cleared' | null = null;
        let metafieldGid: string | null = null;
        // Set only by a `restore`, to null, and persisted in the SAME update
        // as the status once Shopify has accepted the restore. An `apply`
        // persists its capture earlier, in its own conditional write, before
        // the Shopify write. `undefined` leaves the column alone.
        let preSalePrice: number | null | undefined;
        // A note to leave on an otherwise successful pass. The status write below
        // clears `scheduleError` by default, because reaching the target IS the
        // success; this carries the one case that succeeds and still has something
        // the merchant needs told.
        let restoreNote: string | null = null;

        if (row.operation === 'expand' && transitions) {
          if (!row.parentVariantId) {
            throw new Error(`[bundleSchedule] expand bundle ${bundleId} has no parent variant`);
          }
          if (shouldBeLive(target)) {
            const items = await loadItems();
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

        // Sale pricing: the one place this app overwrites merchant data (the
        // parent variant's own price). Runs after the metafield work and
        // before the status write, so a failure here leaves the status
        // untouched and the whole step is retried next pass.
        //
        // Deliberately NOT nested inside the operation branch or inside
        // `transitions`: a row holding a capture must be restorable whatever
        // its operation now says and whether or not its window is doing
        // anything today. `saleLive` is the only thing that decides an APPLY,
        // and it is expand-only.
        //
        // Expand-only on the apply side, deliberately: an expand parent is the
        // product a shopper browses, so its page price is what they see. A
        // merge parent is a representative line for a cart assembled from
        // components and is never browsed, so repricing it would write to a
        // product nobody looks at; update bundles are likewise left alone.
        if (saleLive || row.preSalePrice !== null) {
          if (!row.parentVariantId) {
            throw new Error(`[bundleSchedule] bundle ${bundleId} has no parent variant to price`);
          }
          const items = await loadItems();
          const action = decideSaleAction(
            {
              price: row.price,
              compareAtPrice: row.compareAtPrice,
              preSalePrice: row.preSalePrice,
              componentSumMinor: items.reduce((sum, i) => sum + i.price * i.qty, 0),
            },
            saleLive,
          );
          // compareAtPrice is overwritten on the variant with NO capture, on
          // purpose. The spec defines it as a standing property of the bundle
          // (the component sum, before, during and after the sale), so it is
          // not merchant state we borrow and must give back, unlike `price`.
          // Capturing it would contradict the spec's three-state table.
          if (action.kind === 'apply') {
            const live = await deps.transports.readVariantPrice(env, domain, row.parentVariantId);
            if (live === null) {
              throw new Error(
                `[bundleSchedule] variant ${row.parentVariantId} no longer exists in Shopify; cannot put bundle ${bundleId} on sale`,
              );
            }
            // Capture BEFORE the Shopify write, and CONDITIONALLY. No
            // transaction spans D1 and Shopify, so the only safe order is the
            // one whose every crash window loses a sale at worst, never the
            // merchant's price: captured-but-not-applied is harmless (the pass
            // sees "on sale" and will not re-capture; the restore writes the
            // same price back), whereas applied-but-not-captured would let the
            // next pass record the SALE price as the original.
            //
            // The write is conditional on the column still being null because
            // `decideSaleAction` read the row at the top of this iteration:
            // two overlapping passes can both decide `apply`, and the second
            // would otherwise read the now-live SALE price and overwrite the
            // capture with it. Losing the race means the other pass owns this
            // sale — nothing has been written here, so simply do not apply.
            const captured = await repos.bundles.capturePreSalePrice(bundleId, live.priceMinor);
            if (captured === null) {
              console.warn(
                `[bundleSchedule] bundle ${bundleId} (${domain}) was captured by a concurrent pass; leaving its sale to that pass`,
              );
            } else {
              // The capture is deliberately KEPT if this throws. A throw does
              // not mean Shopify rejected the write: a timeout, 502 or dropped
              // connection can surface after Shopify has committed the sale
              // price. Clearing the capture would then erase the only record
              // of the real price, and the next pass would read the SALE price
              // as "live" and capture that as the original. Keeping it is safe
              // either way: if the write landed, the restore puts the real
              // price back; if not, the restore rewrites a price that is
              // already live. The cost of keeping is at worst a missed sale.
              await deps.transports.setVariantPricing(env, domain, row.parentVariantId, {
                priceMinor: action.priceMinor,
                compareAtMinor: action.compareAtMinor,
                currencyCode: live.currencyCode,
              });
            }
          } else if (action.kind === 'restore') {
            // Currency comes from Shopify exactly as `apply` gets it, never
            // from the cached shop column: the captured amount is in minor
            // units of the currency it was read in, and re-expanding it with
            // a different exponent would restore a price wrong by 100x.
            const live = await deps.transports.readVariantPrice(env, domain, row.parentVariantId);
            if (live === null) {
              // The variant was deleted in Shopify while the sale was live.
              // Everywhere else a failed restore KEEPS the capture, because
              // the price can still be put back on a later pass. Here it
              // cannot: there is no variant left to put it back on. Holding it
              // would re-fail every five minutes forever and — since DELETE
              // refuses a bundle that still holds a capture — leave the bundle
              // permanently undeletable. So the capture is released and the
              // reason recorded, rather than guarding a price with nowhere to
              // go. This is the ONE case where clearing without a confirmed
              // write is right, and it is right because the thing being
              // guarded no longer exists.
              restoreNote = `The parent variant no longer exists in Shopify, so its pre-sale price of ${row.preSalePrice} could not be restored.`;
              preSalePrice = null;
            } else {
              await deps.transports.setVariantPricing(env, domain, row.parentVariantId, {
                priceMinor: action.priceMinor,
                compareAtMinor: action.compareAtMinor,
                currencyCode: live.currencyCode,
              });
              // Only now that Shopify has agreed. Before this point a failure
              // throws past here and the captured price survives for the retry.
              preSalePrice = null;
            }
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
        // `status` only when there is a transition to record: a row swept in
        // purely to be restored (a Draft one above all) keeps the status its
        // merchant chose.
        await repos.bundles.update(bundleId, {
          ...(transitions ? { status: target } : {}),
          scheduleError: restoreNote,
          ...(preSalePrice !== undefined ? { preSalePrice } : {}),
        });
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
