import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./graphqlAdmin', () => ({
  adminGraphql: vi.fn(),
}));

import { adminGraphql } from './graphqlAdmin';
import { removeCartTransformMetafieldDefinitions, getMetafieldSetupStatus } from './metafieldDefinitions';
import type { Env } from '../types/env';

describe('removeCartTransformMetafieldDefinitions', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';

  beforeEach(() => vi.clearAllMocks());

  it('finds and deletes both definitions (variant composition + shop merge_bundles) when present', async () => {
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { metafieldDefinitions: { nodes: [{ id: 'gid://shopify/MetafieldDefinition/1' }] } } })
      .mockResolvedValueOnce({ data: { metafieldDefinitionDelete: { deletedDefinitionId: 'gid://shopify/MetafieldDefinition/1', userErrors: [] } } })
      .mockResolvedValueOnce({ data: { metafieldDefinitions: { nodes: [{ id: 'gid://shopify/MetafieldDefinition/2' }] } } })
      .mockResolvedValueOnce({ data: { metafieldDefinitionDelete: { deletedDefinitionId: 'gid://shopify/MetafieldDefinition/2', userErrors: [] } } });

    await removeCartTransformMetafieldDefinitions(env, shopDomain);

    expect(adminGraphql).toHaveBeenCalledTimes(4);

    const [, , findQuery1, findVars1] = vi.mocked(adminGraphql).mock.calls[0];
    expect(findQuery1).toContain('metafieldDefinitions');
    expect(findVars1).toEqual({ ownerType: 'PRODUCTVARIANT', namespace: '$app:cart-transform', key: 'composition' });

    const [, , deleteQuery1, deleteVars1] = vi.mocked(adminGraphql).mock.calls[1];
    expect(deleteQuery1).toContain('metafieldDefinitionDelete');
    expect(deleteVars1).toEqual({ id: 'gid://shopify/MetafieldDefinition/1', deleteAllAssociatedMetafields: false });

    const [, , , findVars2] = vi.mocked(adminGraphql).mock.calls[2];
    expect(findVars2).toEqual({ ownerType: 'SHOP', namespace: '$app:cart-transform', key: 'merge_bundles' });

    const [, , , deleteVars2] = vi.mocked(adminGraphql).mock.calls[3];
    expect(deleteVars2).toEqual({ id: 'gid://shopify/MetafieldDefinition/2', deleteAllAssociatedMetafields: false });
  });

  it('is idempotent: swallows an absent definition (no delete call) without throwing', async () => {
    vi.mocked(adminGraphql).mockResolvedValue({ data: { metafieldDefinitions: { nodes: [] } } });

    await expect(removeCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();

    // Two find calls (one per definition), zero delete calls.
    expect(adminGraphql).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(adminGraphql).mock.calls) {
      expect(call[2]).not.toContain('metafieldDefinitionDelete');
    }
  });

  it('logs and continues (does not throw) on a delete userError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminGraphql)
      .mockResolvedValueOnce({ data: { metafieldDefinitions: { nodes: [{ id: 'gid://shopify/MetafieldDefinition/1' }] } } })
      .mockResolvedValueOnce({
        data: {
          metafieldDefinitionDelete: {
            deletedDefinitionId: null,
            userErrors: [{ field: ['id'], message: 'not found', code: 'INVALID' }],
          },
        },
      })
      .mockResolvedValue({ data: { metafieldDefinitions: { nodes: [] } } });

    await expect(removeCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs and continues (does not throw) on a transport/GraphQL error from the find query', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminGraphql).mockRejectedValue(new Error('network down'));

    await expect(removeCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs and continues on top-level GraphQL errors array from the find query', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminGraphql).mockResolvedValue({ errors: [{ message: 'boom' }] });

    await expect(removeCartTransformMetafieldDefinitions(env, shopDomain)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('getMetafieldSetupStatus', () => {
  const env = {} as Env;
  const shopDomain = 'test-shop.myshopify.com';

  beforeEach(() => vi.clearAllMocks());

  it('reports mergeBundlesValuePresent true when the shop metafield has a non-empty value', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({ data: { shop: { metafield: { value: '[{"a":1}]' } } } });

    await expect(getMetafieldSetupStatus(env, shopDomain)).resolves.toEqual({ mergeBundlesValuePresent: true });
  });

  it('reports mergeBundlesValuePresent false when the metafield is missing, empty, or "[]"', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({ data: { shop: { metafield: null } } });
    await expect(getMetafieldSetupStatus(env, shopDomain)).resolves.toEqual({ mergeBundlesValuePresent: false });

    vi.mocked(adminGraphql).mockResolvedValueOnce({ data: { shop: { metafield: { value: '[]' } } } });
    await expect(getMetafieldSetupStatus(env, shopDomain)).resolves.toEqual({ mergeBundlesValuePresent: false });
  });

  it('throws on top-level GraphQL errors', async () => {
    vi.mocked(adminGraphql).mockResolvedValueOnce({ errors: [{ message: 'boom' }] });

    await expect(getMetafieldSetupStatus(env, shopDomain)).rejects.toThrow();
  });
});
