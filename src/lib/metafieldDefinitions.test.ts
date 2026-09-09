import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({
  adminGraphql: vi.fn(),
}));

import { adminGraphql } from './graphqlAdmin';
import { ensureCartTransformMetafieldDefinitions } from './metafieldDefinitions';
import type { Env } from '../types/env';

describe('ensureCartTransformMetafieldDefinitions', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';

  beforeEach(() => vi.clearAllMocks());

  it('attempts both definitions (variant composition + shop merge_bundles) via metafieldDefinitionCreate', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: { metafieldDefinitionCreate: { createdDefinition: { id: 'gid://shopify/MetafieldDefinition/1' }, userErrors: [] } },
    });

    await ensureCartTransformMetafieldDefinitions(env, shopDomain);

    expect(adminGraphql).toHaveBeenCalledTimes(2);

    const [, , firstQuery, firstVars] = vi.mocked(adminGraphql).mock.calls[0];
    expect(firstQuery).toContain('metafieldDefinitionCreate');
    expect(firstVars).toEqual({
      definition: expect.objectContaining({
        ownerType: 'PRODUCTVARIANT',
        namespace: '$app:cart-transform',
        key: 'composition',
        type: 'json',
        access: { admin: 'MERCHANT_READ' },
      }),
    });

    const [, , , secondVars] = vi.mocked(adminGraphql).mock.calls[1];
    expect(secondVars).toEqual({
      definition: expect.objectContaining({
        ownerType: 'SHOP',
        namespace: '$app:cart-transform',
        key: 'merge_bundles',
        type: 'json',
        access: { admin: 'MERCHANT_READ' },
      }),
    });
  });

  it('swallows a TAKEN userError (definition already exists) without throwing', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldDefinitionCreate: {
          createdDefinition: null,
          userErrors: [{ field: ['definition', 'namespace'], message: 'Taken', code: 'TAKEN' }],
        },
      },
    });

    await expect(ensureCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(adminGraphql).toHaveBeenCalledTimes(2);
  });

  it('swallows an UNSTRUCTURED_ALREADY_EXISTS userError without throwing', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldDefinitionCreate: {
          createdDefinition: null,
          userErrors: [
            { field: ['definition', 'namespace'], message: 'already in use', code: 'UNSTRUCTURED_ALREADY_EXISTS' },
          ],
        },
      },
    });

    await expect(ensureCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
  });

  it('logs and continues (does not throw) on a genuine userError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        metafieldDefinitionCreate: {
          createdDefinition: null,
          userErrors: [{ field: ['definition', 'type'], message: 'invalid type', code: 'INVALID' }],
        },
      },
    });

    await expect(ensureCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs and continues (does not throw) on a transport/GraphQL error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminGraphql).mockRejectedValue(new Error('network down'));

    await expect(ensureCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs and continues on top-level GraphQL errors array', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminGraphql).mockResolvedValue({ errors: [{ message: 'boom' }] });

    await expect(ensureCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
