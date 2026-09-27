import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({ adminGraphql: vi.fn() }));

import { adminGraphql } from './graphqlAdmin';
import { resolveDiscountFunctionId } from './discountFunctions';
import type { Env } from '../types/env';

const ENV = {} as Env;
const SHOP = 'test.myshopify.com';

function functions(nodes: Array<{ id: string; handle: string; title: string; apiType: string }>) {
  vi.mocked(adminGraphql).mockResolvedValue({ data: { shopifyFunctions: { nodes } } } as never);
}

describe('resolveDiscountFunctionId', () => {
  beforeEach(() => vi.mocked(adminGraphql).mockReset());

  it('matches on handle, not on the display title', async () => {
    functions([
      { id: 'gid://shopify/Function/1', handle: 'discount-bundle', title: 'Buy X, Get Y', apiType: 'discount' },
      // The title has been renamed once already in this repo; the handle has not.
      { id: 'gid://shopify/Function/2', handle: 'discount-tier', title: 'Something Else Entirely', apiType: 'discount' },
    ]);

    await expect(resolveDiscountFunctionId(ENV, SHOP, 'discount-tier'))
      .resolves.toBe('gid://shopify/Function/2');
  });

  // Review Focus #4 — never fall back to "some other function", which would
  // create a discount priced by the wrong engine.
  it('throws loudly when the function is not deployed on the shop', async () => {
    functions([
      { id: 'gid://shopify/Function/1', handle: 'discount-bundle', title: 'Buy X, Get Y', apiType: 'discount' },
    ]);

    await expect(resolveDiscountFunctionId(ENV, SHOP, 'discount-tier'))
      .rejects.toThrow(/discount-tier/);
  });

  it('throws on GraphQL errors rather than returning a guess', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ errors: [{ message: 'boom' }] } as never);

    await expect(resolveDiscountFunctionId(ENV, SHOP, 'discount-tier')).rejects.toThrow();
  });
});
