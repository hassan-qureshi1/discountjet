import { createTemplateRepository } from '../../db/repositories';
import type { TemplateSeed } from '../../db/repositories';
import type { TierFormData } from '../discountEngines/tier';

/**
 * The shipped promotion templates.
 *
 * Defaults choose the SHAPE of a promotion, never the numbers — a template that
 * pre-filled "20%" would be guessing at the merchant's margin. Values stay
 * blank; the merchant fills them in.
 *
 * Stage 1 ships the three that resolve to the `tier` engine. The bundle and
 * special templates arrive with their form bodies in Stage 2.
 */
function tierDefaults(over: Partial<TierFormData>): string {
  const base: TierFormData = {
    message: '',
    applyTo: 'price',
    discountType: 'percentage',
    productDiscountSelectionStrategy: 'MAXIMUM',
    platform: 'BOTH',
    tiers: [],
  };
  return JSON.stringify({ ...base, ...over });
}

const emptyTier = (id: string, minQty: string) => ({
  id, value: '', selectorType: 'variant_id' as const, targets: '[]', min_qty: minQty,
});

export const TEMPLATE_CATALOGUE: TemplateSeed[] = [
  {
    slug: 'pct-off',
    name: 'Percentage off',
    description: 'Take a straight percentage off the products you choose.',
    example: '15% off this collection',
    category: 'Save %',
    symbol: '%',
    type: 'tier',
    sortOrder: 10,
    defaults: tierDefaults({ tiers: [emptyTier('t1', '')] }),
  },
  {
    slug: 'buy-more',
    name: 'Buy more, save more',
    description: 'The more a shopper buys, the bigger the discount.',
    example: 'Buy 3, get 20% off',
    category: 'Volume',
    symbol: '%',
    type: 'tier',
    sortOrder: 20,
    defaults: tierDefaults({
      tiers: [emptyTier('t1', '2'), emptyTier('t2', '3'), emptyTier('t3', '5')],
    }),
  },
  {
    slug: 'clearance',
    name: 'Clearance / RRP markdown',
    description: 'Mark products down from their compare-at price.',
    example: 'Was $80, now $60',
    category: 'Clearance',
    symbol: '%',
    type: 'tier',
    sortOrder: 30,
    defaults: tierDefaults({
      applyTo: 'compare_at_price',
      discountType: 'amount',
      tiers: [emptyTier('t1', '')],
    }),
  },
];

/** Idempotent: safe to run on every install. */
export async function seedTemplates(d1: D1Database): Promise<void> {
  await createTemplateRepository(d1).upsertMany(TEMPLATE_CATALOGUE);
}
