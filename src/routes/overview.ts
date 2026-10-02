import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import type { BundleRow } from '../db/repositories/BundleRepository';
import type { WebhookEventRow } from '../db/repositories/WebhookEventRepository';

export const overviewRoutes = new Hono<AppEnv>();

/** A dashboard card. `detail` sits under the number; `badges` sit beside it. */
interface OverviewStat {
  label: string;
  value: string;
  detail: string | null;
  badges: Array<{ label: string; tone: 'success' | 'info' | 'warning' | 'critical' | 'neutral' }>;
}

interface ActivityItem {
  id: string;
  title: string;
  action: 'created' | 'updated' | 'deleted' | 'other';
  meta: string;
  at: string;
}

interface ScheduleItem {
  id: string;
  name: string;
  operation: BundleRow['operation'];
  status: BundleRow['status'];
  window: string | null;
  campaignId: string | null;
}

interface OverviewDto {
  shopName: string | null;
  stats: OverviewStat[];
  recentActivity: ActivityItem[];
  bundleSchedule: ScheduleItem[];
  generatedAt: string;
}

const ACTIVITY_LIMIT = 8;
const SCHEDULE_LIMIT = 6;

/**
 * How recent the newest webhook has to be before we stop calling the link
 * "connected". Generous on purpose — see `syncStat` for why this is a
 * last-contact reading rather than a health check.
 */
const RECENT_CONTACT_MS = 24 * 60 * 60 * 1000;

function relative(from: string, now: number): string {
  const then = Date.parse(from);
  if (Number.isNaN(then)) return 'unknown';
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function actionOf(topic: string): ActivityItem['action'] {
  if (topic.endsWith('/create')) return 'created';
  if (topic.endsWith('/update')) return 'updated';
  if (topic.endsWith('/delete')) return 'deleted';
  return 'other';
}

/**
 * The webhook card.
 *
 * Deliberately NOT the spec's "Healthy / Delayed / Errors". `webhook_event`
 * records a delivery id, a topic, a shop and a timestamp — there is no
 * processed flag and no error column, so a health verdict could only be
 * inferred from recency. That inference is wrong in the ordinary case: these
 * webhooks fire when a discount CHANGES, so a shop that simply has not been
 * edited this week would be reported as unhealthy while nothing is wrong.
 *
 * So the card reports what the table can actually support — when Shopify last
 * reached us, and how much it has sent — and says "no events yet" rather than
 * inventing a verdict. A real health signal needs a processed/error column on
 * `webhook_event`; that is a schema change and belongs to its own slice.
 */
function syncStat(events: WebhookEventRow[], now: number): OverviewStat {
  const newest = events[0];
  if (!newest) {
    return {
      label: 'Webhook sync',
      value: 'No events yet',
      detail: 'Shopify has not sent this app a discount webhook.',
      badges: [],
    };
  }

  const fresh = now - Date.parse(newest.receivedAt) < RECENT_CONTACT_MS;
  return {
    label: 'Webhook sync',
    value: fresh ? 'Connected' : 'Quiet',
    detail: `last event ${relative(newest.receivedAt, now)}`,
    badges: [{
      label: `${events.length} recent`,
      tone: fresh ? 'success' : 'neutral',
    }],
  };
}

function windowLabel(row: BundleRow, now: number): string | null {
  if (!row.scheduleStart && !row.scheduleEnd) return null;
  const start = row.scheduleStart ? relative(row.scheduleStart, now) : null;
  const end = row.scheduleEnd ? relative(row.scheduleEnd, now) : null;
  if (start && end) return `started ${start} · ends ${end}`;
  if (start) return `starts ${start}`;
  return `ends ${end}`;
}

// GET /api/overview — the dashboard's single read. Protected by `requireShop`
// like every other /api route; it has no PUBLIC_API_PATHS entry and must not
// get one, because every number on it is one shop's commercial data.
//
// Read-only and computed on demand: no rollup table, no cache, no Admin API
// call. Four small indexed queries against D1 is cheaper than the staleness a
// cache would introduce on a page whose whole job is to say what is true now.
overviewRoutes.get('/api/overview', async (c) => {
  const repos = c.get('repos');
  const shopId = c.get('shopId');
  const now = Date.now();

  const shop = await repos.shops.findById(shopId);
  if (!shop) return c.json({ error: 'Shop not found' }, 404);

  const [discounts, bundles, events, scheduled] = await Promise.all([
    repos.discounts.overviewCounts(),
    repos.bundles.overviewCounts(),
    repos.events.listRecent(shopId, ACTIVITY_LIMIT),
    repos.bundles.listRecentlyScheduled(SCHEDULE_LIMIT),
  ]);

  // One scoped IN lookup turns the ledger's GIDs into names. The feed is the
  // only place a merchant meets a raw `gid://shopify/DiscountAutomaticNode/…`,
  // and it told them nothing.
  const names = await repos.discounts.namesByGids(
    [...new Set(events.map((e) => e.shopifyGid).filter((gid): gid is string => gid !== null))],
  );

  // The breakdown counts ACTIVE discounts only, so it sums to the number above
  // it. `unknown` is shown only when it is non-zero — a discount this app did
  // not create has no type, and naming that bucket on every shop would read as
  // a fault rather than as the ordinary thing it is.
  const typeParts = [
    `${discounts.byType.tier} tier`,
    `${discounts.byType.bundle} bundle`,
    `${discounts.byType.special} special`,
    ...(discounts.byType.unknown > 0 ? [`${discounts.byType.unknown} other`] : []),
  ];

  const stats: OverviewStat[] = [
    {
      label: 'Active discounts',
      value: String(discounts.active),
      detail: typeParts.join(' · '),
      badges: discounts.inactive > 0
        ? [{ label: `${discounts.inactive} inactive`, tone: 'warning' }]
        : [],
    },
    {
      label: 'Bundles',
      value: String(bundles.total),
      detail: `${bundles.byOperation.expand} expand · ${bundles.byOperation.merge} merge`,
      badges: [
        ...(bundles.byStatus.Active > 0
          ? [{ label: `${bundles.byStatus.Active} active`, tone: 'success' as const }]
          : []),
        ...(bundles.byStatus.Scheduled > 0
          ? [{ label: `${bundles.byStatus.Scheduled} scheduled`, tone: 'info' as const }]
          : []),
        ...(bundles.byStatus.Ended > 0
          ? [{ label: `${bundles.byStatus.Ended} ended`, tone: 'neutral' as const }]
          : []),
      ],
    },
    syncStat(events, now),
  ];

  const recentActivity: ActivityItem[] = events.map((event) => ({
    id: event.id,
    // The mirror tombstones rather than deletes, so a deleted discount still
    // has its name — which is why a delete event can be named at all. The
    // fallback is for an event about a discount this app never mirrored: say
    // that plainly instead of printing a GID nobody can read.
    title: (event.shopifyGid ? names.get(event.shopifyGid) : null) ?? 'A discount outside this app',
    action: actionOf(event.topic),
    meta: event.topic,
    at: event.receivedAt,
  }));

  const bundleSchedule: ScheduleItem[] = scheduled.map((row) => ({
    id: row.id,
    name: row.name,
    operation: row.operation,
    status: row.status,
    window: windowLabel(row, now),
    campaignId: row.campaignId,
  }));

  const dto: OverviewDto = {
    shopName: shop.name,
    stats,
    recentActivity,
    bundleSchedule,
    generatedAt: new Date(now).toISOString(),
  };
  return c.json(dto);
});
