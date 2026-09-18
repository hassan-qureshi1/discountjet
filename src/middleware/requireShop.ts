import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/env.d';
import { createDb } from '../db/db';
import { createRepos } from '../db/repos';
import { getCurrentShop } from './shopAuth';

// Routes under /api/* that are intentionally public (no shop auth required).
// Add a path here ONLY with explicit justification — all other /api/* routes
// are protected automatically.
const PUBLIC_API_PATHS = new Set<string>([
  // No public routes by default. Add entries here with a comment explaining why.
]);

export const requireShop: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Built before the auth check so public routes get a data layer too, and so
  // auth itself goes through the same (swappable) stores the handlers use.
  const repos = createRepos(createDb(c.env.DB));
  c.set('repos', repos);

  if (PUBLIC_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const shop = await getCurrentShop(c, repos.shops);
  if (!shop) return c.json({ error: 'Unauthorized' }, 401);

  // Both the id and the domain come from the one row this lookup already
  // read. Handlers needing the `*.myshopify.com` domain for an Admin API
  // call take it from here (see `requireShopDomain`) instead of re-selecting
  // the same row — a PUT /api/bundles/:id used to do that up to three times
  // in a single request.
  c.set('shopId', shop.id);
  c.set('shopDomain', shop.myshopifyDomain);
  await next();
};
