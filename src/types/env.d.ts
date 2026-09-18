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

export type AppEnv = {
  Bindings: Env;
  Variables: {
    shopId: string;
    // The caller's `*.myshopify.com` domain, read once by `requireShop`.
    // Nullable because the column is — use `requireShopDomain(c)` to read it
    // where a domain is required, rather than testing for null at each site.
    shopDomain: string | null;
  };
};
