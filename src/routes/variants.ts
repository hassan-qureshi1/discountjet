import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';
import { requireShopDomain } from '../lib/shopDomain';
import {
  MAX_VARIANT_IDS,
  VARIANT_GID,
  resolveVariants,
} from '../lib/variantResolver';

export const variantRoutes = new Hono<AppEnv>();

// GET /api/variants?ids=<gid>,<gid> — resolves product + variant titles, price
// and a variant-level admin deep link for a set of variant gids, in ONE Admin
// call.
//
// Deliberately not persisted: the editor resolves names at page load so a
// merchant renaming a product in Shopify is reflected immediately, and so the
// app never holds a stale copy of catalogue data it doesn't own. The one
// exception is `bundle_item.name`, which is read only when a variant no longer
// resolves — see the column comment in `src/db/schema.ts`.
variantRoutes.get('/api/variants', async (c) => {
  const raw = c.req.query('ids');
  if (!raw || raw.trim() === '') {
    return c.json({ error: 'Query parameter `ids` is required.' }, 400);
  }

  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id !== ''))];

  if (ids.length === 0) {
    return c.json({ error: 'Query parameter `ids` is required.' }, 400);
  }
  if (ids.length > MAX_VARIANT_IDS) {
    return c.json({ error: `Too many ids: ${ids.length} requested, max ${MAX_VARIANT_IDS}.` }, 400);
  }

  const invalid = ids.filter((id) => !VARIANT_GID.test(id));
  if (invalid.length > 0) {
    return c.json({ error: `Not ProductVariant ids: ${invalid.join(', ')}` }, 400);
  }

  const shopDomain = requireShopDomain(c);

  let resolved;
  try {
    resolved = await resolveVariants(shopDomain, c.env, ids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }

  return c.json({ variants: ids.map((id) => resolved.get(id) ?? { id, exists: false }) });
});
