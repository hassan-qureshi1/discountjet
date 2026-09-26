import { describe, it, expect } from 'vitest';
import { sumItemPrices } from './preview';
import { formatMoney } from '../lib/money';

describe('sumItemPrices', () => {
  it('sums known item prices by quantity', () => {
    expect(sumItemPrices([{ price: 10, qty: 2 }, { price: 5, qty: 1 }])).toBe(25);
  });

  it('does not let an unresolved item price contribute a silent zero to the total', () => {
    const total = sumItemPrices([{ price: 10, qty: 1 }, { price: null, qty: 1 }]);
    expect(total).toBeNull();
    // Rendered, this must be the em dash — never "$10.00" (dropping the
    // unknown item) and never "$10" treating the unknown item as free.
    const rendered = total !== null ? formatMoney({ amount: String(total), currencyCode: 'USD' }) : formatMoney(null);
    expect(rendered).toBe('—');
  });

  it('treats an empty item list as a known total of zero, not unknown', () => {
    expect(sumItemPrices([])).toBe(0);
  });
});
