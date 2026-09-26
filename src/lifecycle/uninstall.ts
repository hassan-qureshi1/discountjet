import type { Env } from '../types/env';
import { createShopRepository } from '../db/repositories';

export async function onShopUninstall(shopDomain: string, env: Env): Promise<void> {
  await createShopRepository(env.DB).markUninstalled(shopDomain, new Date().toISOString());
}
