import { describe, expect, it } from 'vitest';
import { flattenPickerSelection, selectionIdsFromVariants } from './picker';
import type { ResolvedVariant } from '../bundles/api';

const P1 = 'gid://shopify/Product/1';
const P2 = 'gid://shopify/Product/2';
const V1 = 'gid://shopify/ProductVariant/11';
const V2 = 'gid://shopify/ProductVariant/12';
const V3 = 'gid://shopify/ProductVariant/21';

describe('flattenPickerSelection', () => {
  it('flattens every selected variant across products, keeping picker order', () => {
    const picked = flattenPickerSelection([
      {
        id: P1,
        title: 'Ayres Chambray Rst1',
        variants: [
          {
            id: V1, title: 'S', displayName: 'Ayres Chambray Rst1 - S', price: '1500.00',
          },
          {
            id: V2, title: 'M', displayName: 'Ayres Chambray Rst1 - M', price: '98.00',
          },
        ],
      },
      {
        id: P2,
        title: 'Canvas Lunch Bag',
        variants: [{
          id: V3, title: 'Khaki', displayName: 'Canvas Lunch Bag - Khaki', price: '32.00',
        }],
      },
    ]);

    expect(picked).toEqual([
      { variantId: V1, price: 1500, title: 'Ayres Chambray Rst1 - S' },
      { variantId: V2, price: 98, title: 'Ayres Chambray Rst1 - M' },
      { variantId: V3, price: 32, title: 'Canvas Lunch Bag - Khaki' },
    ]);
  });

  it('builds a label from the product and variant titles when displayName is absent', () => {
    const [picked] = flattenPickerSelection([
      { id: P1, title: 'Ayres Chambray Rst1', variants: [{ id: V1, title: 'S', price: '1500.00' }] },
    ]);

    expect(picked.title).toBe('Ayres Chambray Rst1 - S');
  });

  it('falls back to the product title alone for a single-variant product', () => {
    const [picked] = flattenPickerSelection([
      { id: P1, title: 'Canvas Lunch Bag', variants: [{ id: V1, title: 'Default Title', price: '32.00' }] },
    ]);

    expect(picked.title).toBe('Canvas Lunch Bag');
  });

  it('leaves price undefined rather than NaN when the picker omits it', () => {
    const [picked] = flattenPickerSelection([
      { id: P1, title: 'Ayres Chambray Rst1', variants: [{ id: V1, title: 'S' }] },
    ]);

    expect(picked.price).toBeUndefined();
  });

  it('skips variants with no id, and products with no variants selected', () => {
    const picked = flattenPickerSelection([
      { id: P1, title: 'Ayres Chambray Rst1', variants: [{ title: 'S', price: '1500.00' }] },
      { id: P2, title: 'Canvas Lunch Bag', variants: [] },
      { id: P2, title: 'Canvas Lunch Bag' },
    ]);

    expect(picked).toEqual([]);
  });
});

describe('selectionIdsFromVariants', () => {
  const resolved = new Map<string, ResolvedVariant>([
    [V1, { id: V1, exists: true, productId: P1 }],
    [V2, { id: V2, exists: true, productId: P1 }],
    [V3, { id: V3, exists: true, productId: P2 }],
  ]);

  it('groups variants under their owning product', () => {
    const { selectionIds, complete } = selectionIdsFromVariants([V1, V2, V3], resolved);

    expect(complete).toBe(true);
    expect(selectionIds).toEqual([
      { id: P1, variants: [{ id: V1 }, { id: V2 }] },
      { id: P2, variants: [{ id: V3 }] },
    ]);
  });

  it('reports incomplete when a variant has no resolved product yet', () => {
    const { selectionIds, complete } = selectionIdsFromVariants([V1, 'gid://shopify/ProductVariant/99'], resolved);

    expect(complete).toBe(false);
    expect(selectionIds).toEqual([{ id: P1, variants: [{ id: V1 }] }]);
  });

  it('treats a deleted variant as unresolvable rather than pre-selecting it', () => {
    const withDeleted = new Map(resolved).set(V2, { id: V2, exists: false });
    const { selectionIds, complete } = selectionIdsFromVariants([V1, V2], withDeleted);

    expect(complete).toBe(false);
    expect(selectionIds).toEqual([{ id: P1, variants: [{ id: V1 }] }]);
  });

  it('is complete and empty for no variants at all', () => {
    expect(selectionIdsFromVariants([], resolved)).toEqual({ selectionIds: [], complete: true });
  });
});
