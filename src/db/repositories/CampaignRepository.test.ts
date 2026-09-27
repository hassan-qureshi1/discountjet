import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { CampaignRepository } from './CampaignRepository';
import { CampaignBundleRepository } from './CampaignBundleRepository';
import { CampaignDiscountRepository } from './CampaignDiscountRepository';
import { createFakeD1 } from './testing/fakeD1';

const SHOP = 'shop-a';

function repos(rows: Record<string, unknown>[] = []) {
  const fake = createFakeD1(() => rows);
  const db = createDb(fake.db);
  return {
    fake,
    campaigns: new CampaignRepository(db, SHOP),
    campaignBundles: new CampaignBundleRepository(db, SHOP),
    campaignDiscounts: new CampaignDiscountRepository(db, SHOP),
  };
}

describe('CampaignRepository', () => {
  it('scopes a status listing by shop as well as status', async () => {
    const { fake, campaigns } = repos();
    await campaigns.listByStatus('Draft');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('Draft');
  });

  it('scopes an unfiltered listing by shop', async () => {
    const { fake, campaigns } = repos();
    await campaigns.listByStatus();

    expect(fake.lastQuery().sql).toMatch(/"shop_id" = \?/i);
    expect(fake.lastQuery().params).toEqual([SHOP]);
  });

  it('scopes findById by shop, so another shop’s campaign reads as absent', async () => {
    const { fake, campaigns } = repos();
    await campaigns.findById('c1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
  });

  it('returns null, never undefined, for a miss', async () => {
    const { campaigns } = repos([]);
    await expect(campaigns.findById('nope')).resolves.toBeNull();
  });
});

describe('CampaignBundleRepository', () => {
  it('scopes a campaign’s bundles by shop as well as campaign', async () => {
    const { fake, campaignBundles } = repos();
    await campaignBundles.listForCampaign('c1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"campaign_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('c1');
  });
});

describe('CampaignDiscountRepository', () => {
  it('scopes a campaign’s discounts by shop as well as campaign', async () => {
    const { fake, campaignDiscounts } = repos();
    await campaignDiscounts.listForCampaign('c1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^select/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"campaign_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('c1');
  });

  it('scopes setPublishResult’s update by shop, so another shop’s row cannot be mutated', async () => {
    const { fake, campaignDiscounts } = repos([{ id: 'd1', shop_id: SHOP }]);
    await campaignDiscounts.setPublishResult('d1', {
      shopifyGid: 'gid://shopify/DiscountNode/1',
      publishState: 'created',
      publishError: null,
    });

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^update/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(params).toContain(SHOP);
  });

  it('scopes deleteForCampaign’s delete by both shop and campaign', async () => {
    const { fake, campaignDiscounts } = repos();
    await campaignDiscounts.deleteForCampaign('c1');

    const { sql, params } = fake.lastQuery();
    expect(sql).toMatch(/^delete/i);
    expect(sql).toMatch(/"shop_id" = \?/i);
    expect(sql).toMatch(/"campaign_id" = \?/i);
    expect(params).toContain(SHOP);
    expect(params).toContain('c1');
  });
});
