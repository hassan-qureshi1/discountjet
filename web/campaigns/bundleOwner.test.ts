import { describe, expect, it } from 'vitest';
import { describeHolder, holdersOfBundle } from './bundleOwner';
import type { Campaign } from './api';

const campaign = (over: Partial<Campaign> & { id: string }): Campaign => ({
  name: `Campaign ${over.id}`,
  description: null,
  status: 'Scheduled',
  scheduleMode: 'window',
  startsAt: null,
  endsAt: null,
  publishedAt: null,
  discounts: [],
  bundleIds: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
} as Campaign);

describe('holdersOfBundle', () => {
  // The regression this exists for: a campaign scheduled for a FUTURE window
  // has never been written to `bundle.campaignId`, so the badge that read that
  // column showed nothing — and the merchant met the publish-time 409 cold.
  it('finds a campaign queued for a future window, which no bundle column names', () => {
    const campaigns = [campaign({
      id: 'dec',
      name: 'December',
      status: 'Scheduled',
      bundleIds: ['b1'],
      startsAt: '2099-12-01T00:00:00.000Z',
      endsAt: '2099-12-31T00:00:00.000Z',
    })];

    expect(holdersOfBundle(campaigns, 'b1', 'mine').map((c) => c.id)).toEqual(['dec']);
  });

  it('ignores the campaign being edited, and any bundle it does not list', () => {
    const campaigns = [
      campaign({ id: 'mine', bundleIds: ['b1'] }),
      campaign({ id: 'other', bundleIds: ['b2'] }),
    ];

    expect(holdersOfBundle(campaigns, 'b1', 'mine')).toEqual([]);
  });

  // An Ended campaign's window has passed, so it blocks nothing and naming it
  // would send the merchant off to fix a clash that does not exist.
  it('ignores campaigns that no longer lock', () => {
    const campaigns = [
      campaign({ id: 'past', status: 'Ended', bundleIds: ['b1'] }),
      campaign({ id: 'draft', status: 'Draft', bundleIds: ['b1'] }),
    ];

    expect(holdersOfBundle(campaigns, 'b1', 'mine')).toEqual([]);
  });

  it('orders a queue the way it will run', () => {
    const campaigns = [
      campaign({ id: 'dec', bundleIds: ['b1'], startsAt: '2099-12-01T00:00:00.000Z' }),
      campaign({ id: 'nov', bundleIds: ['b1'], startsAt: '2099-11-01T00:00:00.000Z' }),
    ];

    expect(holdersOfBundle(campaigns, 'b1', 'mine').map((c) => c.id)).toEqual(['nov', 'dec']);
  });
});

describe('describeHolder', () => {
  it('names the campaign AND its window, which is the dates to avoid', () => {
    const label = describeHolder(campaign({
      id: 'dec',
      name: 'December',
      status: 'Scheduled',
      startsAt: '2099-12-01T00:00:00.000Z',
      endsAt: '2099-12-31T00:00:00.000Z',
    }));

    expect(label).toContain('December');
    expect(label).toContain('Scheduled');
    expect(label).toContain('2099');
  });

  it('says a campaign with no end runs onwards, since it overlaps everything after its start', () => {
    const label = describeHolder(campaign({
      id: 'forever', startsAt: '2099-12-01T00:00:00.000Z', endsAt: null,
    }));

    expect(label).toContain('onwards');
  });
});
