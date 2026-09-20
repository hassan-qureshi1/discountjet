export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SESSION_KV: KVNamespace;
  R2: R2Bucket;
  ENVIRONMENT?: string;
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_API_SECRET: string;
  HOST: string;
}

import type { Repositories } from '../db/repositories';

export type AppEnv = {
  Bindings: Env;
  Variables: {
    // The request's data layer, as interfaces. Handlers use these instead of
    // constructing a repository, which is the seam tests inject fakes through.
    repos: Repositories;
    shopId: string;
    // The caller's `*.myshopify.com` domain, read once by `requireShop`.
    // Nullable because the column is — use `requireShopDomain(c)` to read it
    // where a domain is required, rather than testing for null at each site.
    shopDomain: string | null;
  };
};
