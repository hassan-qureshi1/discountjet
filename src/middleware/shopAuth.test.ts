import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCurrentShop } from './shopAuth';
import type { Context } from 'hono';
import type { Env } from '../types/env';
import { InMemoryShopStore, shopRow } from '../db/repos/inMemory';

// Mock createShopify so decodeSessionToken is controllable in tests.
// The real implementation calls SHOPIFY_API_SECRET for HMAC verification
// which we cannot reproduce in unit tests without real secrets.
// createSessionStorage is also mocked — the token exchange path calls it
// to load/store the offline session, which requires a live KV namespace.
vi.mock('../shopify', () => ({
  createShopify: vi.fn(),
  createSessionStorage: vi.fn(() => ({
    loadSession: vi.fn().mockResolvedValue({ isActive: () => true }),
    storeSession: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createShopify } from '../shopify';

/**
 * The installed shops `getCurrentShop` can resolve against. A real store
 * implementation rather than a stubbed query chain, so these tests assert on
 * the lookup's result rather than on how the lookup was built.
 */
function shopsWith(...rows: Array<{ id: string; myshopifyDomain: string }>) {
  return new InMemoryShopStore(
    rows.map((r) => shopRow({ id: r.id, myshopifyDomain: r.myshopifyDomain })),
  );
}

function mockDecodeSessionToken(dest: string) {
  vi.mocked(createShopify).mockReturnValue({
    session: {
      decodeSessionToken: vi.fn().mockResolvedValue({ dest }),
    },
  } as any);
}

function mockDecodeSessionTokenThrows(error = new Error('Invalid token')) {
  vi.mocked(createShopify).mockReturnValue({
    session: {
      decodeSessionToken: vi.fn().mockRejectedValue(error),
    },
  } as any);
}

function createMockContext(options: {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  env?: Partial<Env>;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) => {
        const lower = name.toLowerCase();
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          if (key.toLowerCase() === lower) return value;
        }
        return undefined;
      },
      query: (name: string) => options.query?.[name] ?? undefined,
    },
    env: {
      DB: {} as unknown as D1Database,
      ...options.env,
    },
  } as unknown as Context<{ Bindings: Env }>;
}

describe('getCurrentShop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts the shop identity from a valid verified JWT Bearer token', async () => {
    const shops = shopsWith({ id: 'shop-123', myshopifyDomain: 'myshop.myshopify.com' });
    mockDecodeSessionToken('https://myshop.myshopify.com');

    const ctx = createMockContext({
      headers: { authorization: 'Bearer valid.signed.token' },
    });

    const result = await getCurrentShop(ctx, shops);
    expect(result).toEqual({ id: 'shop-123', myshopifyDomain: 'myshop.myshopify.com' });
  });

  it('returns null when Authorization header is missing', async () => {
    const shops = shopsWith();
    const ctx = createMockContext({});
    const result = await getCurrentShop(ctx, shops);
    expect(result).toBeNull();
  });

  it('falls back to x-shop-domain header in local dev when JWT verification fails', async () => {
    const shops = shopsWith({ id: 'shop-456', myshopifyDomain: 'fallback.myshopify.com' });
    mockDecodeSessionTokenThrows();

    const ctx = createMockContext({
      headers: {
        authorization: 'Bearer forged.or.expired.token',
        'x-shop-domain': 'fallback.myshopify.com',
      },
      env: { ENVIRONMENT: 'development' },
    });

    const result = await getCurrentShop(ctx, shops);
    expect(result).toEqual({ id: 'shop-456', myshopifyDomain: 'fallback.myshopify.com' });
  });

  it('ignores x-shop-domain header in production when JWT verification fails', async () => {
    const shops = shopsWith({ id: 'shop-456', myshopifyDomain: 'fallback.myshopify.com' });
    mockDecodeSessionTokenThrows();

    const ctx = createMockContext({
      headers: {
        authorization: 'Bearer forged.or.expired.token',
        'x-shop-domain': 'fallback.myshopify.com',
      },
    });

    const result = await getCurrentShop(ctx, shops);
    expect(result).toBeNull();
  });

  it('ignores x-shopify-shop-domain header (removed to prevent auth bypass)', async () => {
    const shops = shopsWith({ id: 'shop-789', myshopifyDomain: 'shopify-header.myshopify.com' });
    const ctx = createMockContext({
      headers: {
        'x-shopify-shop-domain': 'shopify-header.myshopify.com',
      },
    });

    const result = await getCurrentShop(ctx, shops);
    expect(result).toBeNull();
  });

  it('returns null when shop is uninstalled (no DB row)', async () => {
    const shops = shopsWith();
    mockDecodeSessionToken('https://uninstalled.myshopify.com');

    const ctx = createMockContext({
      headers: { authorization: 'Bearer valid.signed.token' },
    });

    const result = await getCurrentShop(ctx, shops);
    expect(result).toBeNull();
  });

  it('returns null when JWT verification throws (forged/expired token)', async () => {
    const shops = shopsWith({ id: 'shop-123', myshopifyDomain: 'myshop.myshopify.com' });
    mockDecodeSessionTokenThrows(new Error('JWT expired'));

    const ctx = createMockContext({
      headers: { authorization: 'Bearer expired.token.here' },
    });

    const result = await getCurrentShop(ctx, shops);
    expect(result).toBeNull();
  });
});
