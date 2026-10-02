import { describe, expect, it } from 'vitest';
import { describePublishOutcome, oversizedDiscounts, totalConfigBytes } from './publishOutcome';
import type { CampaignDiscount, PublishCampaignResponse } from './api';
import { METAFIELD_MAX_SIZE_BYTES } from '../../src/lib/discountEngines/tier';

const discount = (overrides: Partial<CampaignDiscount> = {}): CampaignDiscount => ({
  id: 'cd1',
  name: 'Spring tiers',
  type: 'tier',
  method: 'automatic',
  code: null,
  configJson: '{}',
  configBytes: 1024,
  shopifyGid: null,
  publishState: 'pending',
  publishError: null,
  ...overrides,
});

const result = (overrides: Partial<PublishCampaignResponse> = {}): PublishCampaignResponse => ({
  status: 'Published',
  created: 0,
  failed: 0,
  bundlesStamped: 0,
  bundlesQueued: 0,
  bundleFailures: [],
  ...overrides,
});

// F5 — the cap is per metafield value, one per discount. Summing them and
// comparing the total blocks a campaign that breaks no limit at all.
describe('oversizedDiscounts', () => {
  it('passes three legitimate 4KB discounts whose SUM exceeds the cap', () => {
    const fourKb = 4 * 1024;
    const discounts = [
      discount({ id: 'a', configBytes: fourKb }),
      discount({ id: 'b', configBytes: fourKb }),
      discount({ id: 'c', configBytes: fourKb }),
    ];

    expect(totalConfigBytes(discounts)).toBeGreaterThan(METAFIELD_MAX_SIZE_BYTES);
    expect(oversizedDiscounts(discounts)).toEqual([]);
  });

  it('flags only the individual discounts over the cap', () => {
    const discounts = [
      discount({ id: 'small', configBytes: 100 }),
      discount({ id: 'big', configBytes: METAFIELD_MAX_SIZE_BYTES + 1 }),
    ];

    expect(oversizedDiscounts(discounts).map((d) => d.id)).toEqual(['big']);
  });

  it('treats exactly the cap as allowed, matching the engine adapters', () => {
    expect(oversizedDiscounts([discount({ configBytes: METAFIELD_MAX_SIZE_BYTES })])).toEqual([]);
  });
});

// F4 — the message must follow the campaign's STORED status, never a count.
describe('describePublishOutcome', () => {
  it('promises a safe retry only when the campaign really went back to Draft', () => {
    const outcome = describePublishOutcome(result({ status: 'Draft', created: 0, failed: 2 }));

    expect(outcome.tone).toBe('critical');
    expect(outcome.summary).toMatch(/stays a Draft/);
  });

  // The distinctive case: a bundles-only campaign whose every bundle was
  // skipped. `created === 0` and `failed === 0`, yet the campaign is NOT a
  // Draft — telling the merchant it is safe to fix and try again is false,
  // because PUT, DELETE and republish all refuse a published campaign.
  it('never says "stays a Draft" for a published campaign that created nothing', () => {
    const outcome = describePublishOutcome(result({
      status: 'Published',
      created: 0,
      failed: 0,
      bundleFailures: [{ bundleId: 'b1', error: 'Bundle b1 is already owned by campaign "Live" (Published).' }],
    }));

    expect(outcome.summary).not.toMatch(/stays a Draft/);
    expect(outcome.title).not.toMatch(/Nothing was published/);
    expect(outcome.summary).toMatch(/clone/i);
  });

  it('reports a genuine partial publish as a warning', () => {
    const outcome = describePublishOutcome(result({ status: 'Scheduled', created: 2, failed: 1 }));

    expect(outcome.tone).toBe('warning');
    expect(outcome.summary).toMatch(/2 discounts created, 1 failed/);
  });
});

// A bundles-only campaign published for a future window creates no discounts
// and stamps nothing today. The banner must still say what it DID do, or the
// merchant reads "0 discounts created" as "nothing happened".
describe('describePublishOutcome — bundles', () => {
  it('names queued bundles apart from scheduled ones', () => {
    const outcome = describePublishOutcome(result({
      status: 'Scheduled', created: 0, bundlesStamped: 0, bundlesQueued: 2,
    }));

    expect(outcome.summary).toContain('0 bundles scheduled now');
    expect(outcome.summary).toContain('2 queued');
  });

  it('says nothing about bundles for a campaign that has none', () => {
    const outcome = describePublishOutcome(result({ created: 1, failed: 1 }));

    expect(outcome.summary).not.toMatch(/bundle/i);
  });
});
