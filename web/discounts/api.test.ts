import {
  describe, expect, it, vi,
} from 'vitest';
import { fetchDiscount, fetchDiscounts } from './api';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('discount data layer', () => {
  it('fetchDiscounts requests /api/discounts and returns discounts + counts', async () => {
    const payload = {
      discounts: [{
        id: '1', name: 'A', symbol: '%', type: 'Tier', status: 'Active', products: 2, updated: 'Just now',
      }],
      counts: {
        all: 1, tier: 1, bundle: 0, special: 0, inactive: 0,
      },
    };
    const f = vi.fn().mockResolvedValue(jsonResponse(payload));
    const res = await fetchDiscounts(f);
    expect(f.mock.calls[0][0]).toBe('/api/discounts');
    expect(res.discounts).toHaveLength(1);
    expect(res.counts.all).toBe(1);
  });

  it('fetchDiscount requests /api/discounts/:id', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({
      discount: {
        id: 'abc', name: 'A', symbol: '%', type: 'Tier', status: 'Active', products: 0, updated: '—',
      },
      campaign: null,
    }));
    const res = await fetchDiscount(f, 'abc');
    expect(f.mock.calls[0][0]).toBe('/api/discounts/abc');
    expect(res.discount.id).toBe('abc');
    expect(res.campaign).toBeNull();
  });
});
