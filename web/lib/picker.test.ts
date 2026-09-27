import { describe, expect, it } from 'vitest';
import {
  flattenPickerSelection, selectionIdsFromVariants, tierItemsFromPicker, toNumericId,
} from './picker';
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

describe('toNumericId', () => {
  // The bug this exists for: the App Bridge picker hands back GIDs, but the
  // discount engines' `targets` are documented as "numeric IDs only" and run
  // them through `Number(...)`. `Number('gid://…')` is NaN, so every target was
  // silently dropped and the whole tier vanished from the built config — a
  // discount that would have gone live doing nothing.
  it('reduces a variant GID to the bare numeric id the engines require', () => {
    expect(toNumericId('gid://shopify/ProductVariant/39496726577322')).toBe('39496726577322');
    expect(Number(toNumericId('gid://shopify/ProductVariant/39496726577322'))).toBe(39496726577322);
  });

  it('reduces a product GID the same way', () => {
    expect(toNumericId('gid://shopify/Product/12345')).toBe('12345');
  });

  it('passes an already-numeric id through unchanged, so it is safe to re-apply', () => {
    expect(toNumericId('39496726577322')).toBe('39496726577322');
  });

  it('returns an empty string for an empty input rather than throwing', () => {
    expect(toNumericId('')).toBe('');
  });
});

describe('tierItemsFromPicker', () => {
  const SELECTION = [{
    id: 'gid://shopify/Product/7',
    title: 'Ayres Chambray',
    variants: [
      { id: 'gid://shopify/ProductVariant/11', title: 'S', sku: 'AC-S' },
      { id: 'gid://shopify/ProductVariant/12', title: 'M', sku: 'AC-M' },
    ],
  }];

  it('in variant mode, yields one item per variant with numeric ids', () => {
    expect(tierItemsFromPicker(SELECTION, 'variant_id')).toEqual([
      {
        productId: '7', variantId: '11', productTitle: 'Ayres Chambray', variantTitle: 'S', sku: 'AC-S',
      },
      {
        productId: '7', variantId: '12', productTitle: 'Ayres Chambray', variantTitle: 'M', sku: 'AC-M',
      },
    ]);
  });

  // The whole point of product mode: one entry for the product, no variantId,
  // because `buildTierConfig` reads `productId` and ignores `variantId` here.
  it('in product mode, yields one item per PRODUCT and no variant ids', () => {
    expect(tierItemsFromPicker(SELECTION, 'product_id')).toEqual([
      { productId: '7', productTitle: 'Ayres Chambray' },
    ]);
  });

  it('produces ids that survive the engine’s Number() conversion', () => {
    tierItemsFromPicker(SELECTION, 'variant_id').forEach((item) => {
      expect(Number.isNaN(Number(item.variantId))).toBe(false);
      expect(Number.isNaN(Number(item.productId))).toBe(false);
    });
  });

  it('drops a product with no id rather than storing a half-item', () => {
    expect(tierItemsFromPicker([{ title: 'No id' }], 'product_id')).toEqual([]);
  });

  it('drops a variant with no id in variant mode', () => {
    expect(tierItemsFromPicker(
      [{ id: 'gid://shopify/Product/7', title: 'P', variants: [{ title: 'no id' }] }],
      'variant_id',
    )).toEqual([]);
  });

  it('de-duplicates a variant the picker returned twice', () => {
    const dupe = [{
      id: 'gid://shopify/Product/7',
      title: 'P',
      variants: [{ id: 'gid://shopify/ProductVariant/11' }, { id: 'gid://shopify/ProductVariant/11' }],
    }];
    expect(tierItemsFromPicker(dupe, 'variant_id')).toHaveLength(1);
  });
});
