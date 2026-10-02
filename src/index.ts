import { Hono } from 'hono';
import { authRoutes } from './routes/auth';
import { exampleRoutes } from './routes/example';
import { discountRoutes } from './routes/discounts';
import { bundleRoutes } from './routes/bundles';
import { variantRoutes } from './routes/variants';
import { shopRoutes } from './routes/shop';
import { previewRoutes } from './routes/preview';
import { templateRoutes } from './routes/templates';
import { campaignRoutes } from './routes/campaigns';
import { webhookRoutes } from './lifecycle/webhooks';
import { createBundleScheduleDeps, runBundleSchedule } from './lifecycle/bundleSchedule';
import type { Env } from './types/env';
import type { AppEnv } from './types/env.d';
import { requireShop } from './middleware/requireShop';

const app = new Hono<AppEnv>();

/**
 * Every unhandled throw becomes `{ error }` JSON.
 *
 * Without this an exception escapes as an opaque platform error with no body,
 * so the client's `apiFetch` — which reads `error` off the response to explain
 * the failure — has nothing to show and falls back to "Something went wrong.
 * Please try again." The merchant is told only that it broke, and so are we:
 * the status and route reach the console, but the cause reaches nobody.
 *
 * The status is deliberately 500: this handler only sees failures nothing
 * planned for. Routes that KNOW what went wrong (a Shopify userError, an
 * unresolvable variant) return their own 4xx/502 with a specific message and
 * never reach here.
 */
app.onError((err, c) => {
  console.error(`[unhandled] ${c.req.method} ${c.req.path}:`, err);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: `Unexpected server error: ${message}` }, 500);
});

// All /api/* routes require an authenticated shop — see middleware/requireShop.ts
app.use('/api/*', requireShop);

// Routes
app.route('/', authRoutes);
app.route('/', webhookRoutes);
app.route('/', exampleRoutes);
app.route('/', discountRoutes);
app.route('/', bundleRoutes);
app.route('/', variantRoutes);
app.route('/', shopRoutes);
app.route('/', campaignRoutes);

// Public template preview page (no auth) — see routes/preview.ts.
app.route('/', previewRoutes);
app.route('/', templateRoutes);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', app: 'cloudflare-shopify-starter' }));

// Catch-all: serve SPA and static assets via Cloudflare Assets binding.
// Must be last so all Worker routes (auth, API, webhooks) take priority.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// Exported for integration tests (see src/api.integration.test.ts).
export { app };

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
