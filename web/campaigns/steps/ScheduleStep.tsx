// web/campaigns/steps/ScheduleStep.tsx
//
// Step 3 of the campaign builder. Immediate vs. windowed, reusing
// `ScheduleCard` for the windowed case — the same component the bundle
// editor uses, so campaigns and bundles never disagree about what a window
// means. Times are entered in the merchant's local timezone and converted to
// UTC only on save (`toUtcIso`/`fromUtcIso`), never hand-rolled here.
import { useEffect, useRef, useState } from 'react';
import {
  Banner, BlockStack, Button, Card, ChoiceList,
} from '@shopify/polaris';
import type { Campaign, CampaignScheduleMode } from '../api';
import { useUpdateCampaign } from '../hooks';
import { ScheduleCard } from '../../components/ScheduleCard';
import { fromUtcIso, toUtcIso } from '../../lib/schedule';

export function ScheduleStep({ campaign }: { campaign: Campaign }) {
  const updateMutation = useUpdateCampaign();
  const [mode, setMode] = useState<CampaignScheduleMode>(campaign.scheduleMode);
  const [hasStart, setHasStart] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [hasEnd, setHasEnd] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('23:59');
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed local state from the campaign exactly once — react-query may hand us
  // a new object reference on background refetch and we don't want to clobber
  // an in-progress edit (see BundleEditor's `initializedRef`).
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    setMode(campaign.scheduleMode);
    if (campaign.startsAt) {
      const { date, time } = fromUtcIso(campaign.startsAt);
      setHasStart(true);
      setStartDate(date);
      setStartTime(time);
    }
    if (campaign.endsAt) {
      const { date, time } = fromUtcIso(campaign.endsAt);
      setHasEnd(true);
      setEndDate(date);
      setEndTime(time);
    }
    initializedRef.current = true;
  }, [campaign]);

  let startsAt: string | null = null;
  let endsAt: string | null = null;
  let scheduleFieldError: string | null = null;
  if (mode === 'window') {
    try {
      if (hasStart && !startDate) {
        scheduleFieldError = 'Enter a start date, or clear "Set a start date" to leave it unbounded.';
      } else if (hasEnd && !endDate) {
        scheduleFieldError = 'Enter an end date, or clear "Set an end date" to leave it unbounded.';
      } else {
        if (hasStart && startDate) startsAt = toUtcIso(startDate, startTime);
        if (hasEnd && endDate) endsAt = toUtcIso(endDate, endTime);
        if (startsAt && endsAt && startsAt >= endsAt) {
          scheduleFieldError = 'The start must be before the end.';
        }
      }
    } catch {
      scheduleFieldError = 'Enter a valid date and time.';
    }
  }

  const handleSave = async () => {
    if (scheduleFieldError) {
      setBannerError(scheduleFieldError);
      return;
    }
    setBannerError(null);
    setSaved(false);
    try {
      await updateMutation.mutateAsync({
        id: campaign.id,
        input: {
          scheduleMode: mode,
          startsAt: mode === 'window' ? startsAt : null,
          endsAt: mode === 'window' ? endsAt : null,
        },
      });
      setSaved(true);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to save the schedule.');
    }
  };

  return (
    <BlockStack gap="400">
      {(bannerError || updateMutation.error) && (
        <Banner tone="critical" onDismiss={() => setBannerError(null)}>
          {bannerError ?? updateMutation.error?.message}
        </Banner>
      )}
      {saved && !bannerError && (
        <Banner tone="success" onDismiss={() => setSaved(false)}>Schedule saved.</Banner>
      )}

      <Card>
        <ChoiceList
          title="When should this campaign go live?"
          choices={[
            { label: 'Publish immediately', value: 'immediate', helpText: 'Everything in this campaign goes live the moment you publish it.' },
            { label: 'Schedule a window', value: 'window', helpText: 'Reuses the same start/end window for every discount and bundle in this campaign.' },
          ]}
          selected={[mode]}
          onChange={(next) => setMode(next[0] as CampaignScheduleMode)}
        />
      </Card>

      {mode === 'window' && (
        <ScheduleCard
          value={{
            hasStart, startDate, startTime, hasEnd, endDate, endTime,
          }}
          onChange={(w) => {
            setHasStart(w.hasStart);
            setStartDate(w.startDate);
            setStartTime(w.startTime);
            setHasEnd(w.hasEnd);
            setEndDate(w.endDate);
            setEndTime(w.endTime);
          }}
          error={scheduleFieldError}
          startHelpText="Leave off to start as soon as the campaign is published."
          endHelpText="Leave off to run until you end the campaign."
          footnote="Times are in your own timezone."
        />
      )}

      <Button onClick={handleSave} loading={updateMutation.isPending} variant="primary">
        Save schedule
      </Button>
    </BlockStack>
  );
}
