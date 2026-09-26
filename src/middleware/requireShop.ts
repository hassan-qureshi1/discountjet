import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/env.d';
import { createRepositories, createShopRepository } from '../db/repositories';
import { getCurrentShop } from './shopAuth';

// Routes under /api/* that are intentionally public (no shop auth required).
// Add a path here ONLY with explicit justification — all other /api/* routes
// are protected automatically.
//
// NOTE: a public route gets NO `repos` on the context. Shop-scoped repositories
// cannot be constructed without a tenant (that is the whole point), and there
// is no tenant before auth. A public route that needs data must build its own
// unscoped repository and justify that too.
const PUBLIC_API_PATHS = new Set<string>([
  // No public routes by default. Add entries here with a comment explaining why.
]);

export const requireShop: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  // Auth runs against the unscoped shop repository — resolving the caller's
  // shop is precisely what we do not have a shop id for yet.
  const shop = await getCurrentShop(c, createShopRepository(c.env.DB));
  if (!shop) return c.json({ error: 'Unauthorized' }, 401);

  // Both the id and the domain come from the one row this lookup already
  // read. Handlers needing the `*.myshopify.com` domain for an Admin API
  // call take it from here (see `requireShopDomain`) instead of re-selecting
  // the same row — a PUT /api/bundles/:id used to do that up to three times
  // in a single request.
  c.set('shopId', shop.id);
  c.set('shopDomain', shop.myshopifyDomain);
  // Every repository on here is already bound to this shop, so no handler
  // passes a shop id and none can forget one.
  c.set('repos', createRepositories(c.env.DB, shop.id));
  await next();
};
