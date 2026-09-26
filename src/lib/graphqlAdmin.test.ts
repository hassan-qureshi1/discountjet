import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./getShopAccessToken', () => ({
  getShopAccessToken: vi.fn().mockResolvedValue('shpat_token'),
}));

import { adminGraphql } from './graphqlAdmin';
import type { Env } from '../types/env';

const env = {} as Env;
const SHOP = 'test-shop.myshopify.com';

beforeEach(() => vi.restoreAllMocks());

describe('adminGraphql', () => {
  it('sends an abort signal so a stalled Admin call cannot hang the Worker', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );

    await adminGraphql(SHOP, env, 'query { shop { id } }');

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout as a named failure, not "operation aborted"', async () => {
    // `fetch` has no default timeout. Before the signal, a Shopify call that
    // never settled took the whole request with it: the Worker stopped
    // responding and the platform returned a body-less 502 that the client
    // could not explain and the server never logged.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    );

    // The message has to name the shop and the budget — it is the only thing
    // that reaches the merchant.
    await expect(adminGraphql(SHOP, env, 'query { shop { id } }'))
      .rejects.toThrow(new RegExp(`${SHOP}.*did not respond within \\d+ms`));
  });

  it('passes a non-timeout network failure through untouched', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

    await expect(adminGraphql(SHOP, env, 'query { shop { id } }'))
      .rejects.toThrow('connection refused');
  });

  it('still surfaces a non-2xx response with its status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 429, statusText: 'Too Many Requests' }),
    );

    await expect(adminGraphql(SHOP, env, 'query { shop { id } }')).rejects.toThrow('429');
  });
});
