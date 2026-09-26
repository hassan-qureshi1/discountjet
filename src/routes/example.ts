import { Hono } from 'hono';
import type { AppEnv } from '../types/env.d';

export const exampleRoutes = new Hono<AppEnv>();

// GET /api/example
// The protected-route pattern end to end: `requireShop` verifies the session
// token and sets `shopId`; here we return that shop's profile. The column
// projection is deliberate: the response never exposes internal columns.
exampleRoutes.get('/api/example', async (c) => {
  const shops = c.get('repos').shops;
  const shop = await shops.findProfile(c.get('shopId'));

  if (!shop) {
    return c.json({ error: 'Shop not found' }, 404);
  }

  return c.json({ shop });
});
