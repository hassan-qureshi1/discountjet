import {
  describe, expect, it, vi,
} from 'vitest';
import {
  createBundle, deleteBundle, fetchActivation, fetchBundle, fetchBundleAdminUrl, fetchBundles, fetchShopPlan, updateBundle,
} from './api';
import type { Bundle, BundleInput } from './api';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

const sampleBundle: Bundle = {
  id: 'b1',
  name: 'Bundle A',
  operation: 'merge',
  items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
  price: 10,
  sumOfItems: 20,
  status: 'Draft',
  metafieldState: 'NotYet',
  updated: 'Just now',
};

describe('bundle data layer', () => {
  it('fetchBundles requests /api/bundles and returns bundles + summary', async () => {
    const payload = {
      bundles: [sampleBundle],
      summary: { count: 1, inCampaigns: 0, avgSaving: 10 },
    };
    const f = vi.fn().mockResolvedValue(jsonResponse(payload));
    const res = await fetchBundles(f);
    expect(f.mock.calls[0][0]).toBe('/api/bundles');
    expect(res.bundles).toHaveLength(1);
    expect(res.summary.count).toBe(1);
  });

  it('fetchBundle requests /api/bundles/:id', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ bundle: sampleBundle }));
    const res = await fetchBundle(f, 'b1');
    expect(f.mock.calls[0][0]).toBe('/api/bundles/b1');
    expect(res.bundle.id).toBe('b1');
  });

  it('createBundle POSTs to /api/bundles with the input as the body', async () => {
    const input: BundleInput = {
      name: 'Bundle A',
      operation: 'merge',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }],
    };
    const f = vi.fn().mockResolvedValue(jsonResponse({ bundle: sampleBundle }));
    const res = await createBundle(f, input);
    expect(f.mock.calls[0][0]).toBe('/api/bundles');
    expect(f.mock.calls[0][1]?.method).toBe('POST');
    expect(f.mock.calls[0][1]?.body).toBe(JSON.stringify(input));
    expect(res.bundle.id).toBe('b1');
  });

  it('updateBundle PUTs to /api/bundles/:id with the input as the body', async () => {
    const input: Partial<BundleInput> = { name: 'Bundle A renamed' };
    const f = vi.fn().mockResolvedValue(jsonResponse({ bundle: sampleBundle }));
    const res = await updateBundle(f, 'b1', input);
    expect(f.mock.calls[0][0]).toBe('/api/bundles/b1');
    expect(f.mock.calls[0][1]?.method).toBe('PUT');
    expect(f.mock.calls[0][1]?.body).toBe(JSON.stringify(input));
    expect(res.bundle.id).toBe('b1');
  });

  it('deleteBundle DELETEs to /api/bundles/:id with no body', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const res = await deleteBundle(f, 'b1');
    expect(f.mock.calls[0][0]).toBe('/api/bundles/b1');
    expect(f.mock.calls[0][1]?.method).toBe('DELETE');
    expect(f.mock.calls[0][1]?.body).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('fetchBundleAdminUrl requests /api/bundles/:id/admin-url', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ url: 'https://mystore.myshopify.com/admin/products/456' }));
    const res = await fetchBundleAdminUrl(f, 'b1');
    expect(f.mock.calls[0][0]).toBe('/api/bundles/b1/admin-url');
    expect(res.url).toBe('https://mystore.myshopify.com/admin/products/456');
  });

  it('fetchShopPlan requests /api/shop/plan', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ updateOpEligible: true, planName: 'Shopify Plus' }));
    const res = await fetchShopPlan(f);
    expect(f.mock.calls[0][0]).toBe('/api/shop/plan');
    expect(res.updateOpEligible).toBe(true);
    expect(res.planName).toBe('Shopify Plus');
  });

  it('fetchActivation requests /api/bundles/activation and returns the body on success', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ active: true }));
    const res = await fetchActivation(f);
    expect(f.mock.calls[0][0]).toBe('/api/bundles/activation');
    expect(res.active).toBe(true);
  });

  it('fetchActivation parses the JSON body even on a non-2xx (e.g. 500) response', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ active: false, error: 'function not deployed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await fetchActivation(f);
    expect(f.mock.calls[0][0]).toBe('/api/bundles/activation');
    expect(res.active).toBe(false);
    expect(res.error).toBe('function not deployed');
  });

  it('fetchActivation passes through the metafields status object when present', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({
        active: true,
        metafields: { mergeBundlesValuePresent: false },
      }),
    );
    const res = await fetchActivation(f);
    expect(res.active).toBe(true);
    expect(res.metafields).toEqual({
      mergeBundlesValuePresent: false,
    });
  });
});
