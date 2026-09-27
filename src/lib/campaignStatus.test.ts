import { describe, expect, it } from 'vitest';
import { deriveCampaignStatus, isCampaignLocking } from './campaignStatus';

const NOW = '2026-10-03T12:00:00.000Z';
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

describe('deriveCampaignStatus', () => {
  it('leaves a Draft alone whatever its window says', () => {
    expect(deriveCampaignStatus('Draft', PAST, FUTURE, NOW)).toBe('Draft');
    expect(deriveCampaignStatus('Draft', null, null, NOW)).toBe('Draft');
  });

  // `immediate` stores a null startsAt, which means "live from publish".
  it('reads a published campaign with no window as Published', () => {
    expect(deriveCampaignStatus('Published', null, null, NOW)).toBe('Published');
  });

  it('reads a future window as Scheduled', () => {
    expect(deriveCampaignStatus('Scheduled', FUTURE, null, NOW)).toBe('Scheduled');
  });

  it('reads an open window as Published - the prototype\'s word for Active', () => {
    expect(deriveCampaignStatus('Scheduled', PAST, FUTURE, NOW)).toBe('Published');
  });

  it('reads a closed window as Ended', () => {
    expect(deriveCampaignStatus('Published', PAST, PAST, NOW)).toBe('Ended');
  });

  it('is boundary-exact, matching deriveStatus', () => {
    expect(deriveCampaignStatus('Scheduled', NOW, FUTURE, NOW)).toBe('Published');
    expect(deriveCampaignStatus('Published', PAST, NOW, NOW)).toBe('Ended');
  });
});

describe('isCampaignLocking', () => {
  // The lock is derived from the OWNING campaign's status, not from a column
  // being set: nothing runs when a window closes, so nothing would clear it.
  it('locks while scheduled or published, releases once ended', () => {
    expect(isCampaignLocking('Scheduled')).toBe(true);
    expect(isCampaignLocking('Published')).toBe(true);
    expect(isCampaignLocking('Ended')).toBe(false);
  });

  it('does not lock from a draft — nothing has been published yet', () => {
    expect(isCampaignLocking('Draft')).toBe(false);
  });
});
