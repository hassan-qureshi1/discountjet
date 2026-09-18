import type { Env } from '../types/env';
import { createDb } from '../db/db';
import { ShopRepository } from '../db/repos/shopRepo';

export async function onShopUninstall(shopDomain: string, env: Env): Promise<void> {
  await new ShopRepository(createDb(env.DB)).markUninstalled(shopDomain, new Date().toISOString());
}
