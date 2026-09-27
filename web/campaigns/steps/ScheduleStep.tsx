// web/campaigns/steps/ScheduleStep.tsx
//
// Step 3 of the campaign builder. Immediate vs. windowed, reusing
// `ScheduleCard` for the windowed case — the same component the bundle
// editor uses, so campaigns and bundles never disagree about what a window
// means. Times are entered in the merchant's local timezone and converted to
// UTC only on save (`toUtcIso`/`fromUtcIso`), never hand-rolled here.
//
// SAVES THROUGH, like every other step: a valid window is persisted via
// `useUpdateCampaign` shortly after the merchant stops typing (debounced, so
// each keystroke doesn't fire a request), and — critically — any still-
// pending edit is flushed immediately when the step unmounts (the merchant
// clicked Back/Next/a Tab). This is a `Draft` campaign whose whole point is
// stamping one window onto every discount and bundle in it; a window that
// silently vanished when the merchant clicked Next would mean the campaign
// publishes IMMEDIATELY instead of on the intended date — discounting live
// inventory right now, with nothing on screen to say so. There is
// deliberately no "unsaved changes" warning as a substitute: a warning still
// relies on the merchant noticing it, where saving through does not.
import { useEffect, useRef, useState } from 'react';
import {
  Banner, BlockStack, Card, ChoiceList, InlineStack, Spinner, Text,
} from '@shopify/polaris';
import type { Campaign, CampaignScheduleMode } from '../api';
import { useUpdateCampaign } from '../hooks';
import { ScheduleCard } from '../../components/ScheduleCard';
import { fromUtcIso, toUtcIso } from '../../lib/schedule';

/** What gets persisted. `null` means "the fields on screen right now don't
 * describe a valid, save-able window" (e.g. a ticked box with a blank date) —
 * distinct from a valid window with no bound, which is `{ ..., startsAt: null }`. */
interface SchedulePayload {
  scheduleMode: CampaignScheduleMode;
  startsAt: string | null;
  endsAt: string | null;
}

const AUTOSAVE_DEBOUNCE_MS = 600;

/** `campaign.startsAt`/`endsAt` split into the shape the date/time fields
 * want, or the "unset" defaults. Pulled out so every `useState` initializer
 * below reads the same seed rather than each re-deriving it slightly
 * differently. */
function seedBound(iso: string | null, defaultTime: string): { has: boolean; date: string; time: string } {
  if (!iso) return { has: false, date: '', time: defaultTime };
  const { date, time } = fromUtcIso(iso);
  return { has: true, date, time };
}

export function ScheduleStep({ campaign }: { campaign: Campaign }) {
  const updateMutation = useUpdateCampaign();

  // Seeded SYNCHRONOUSLY from `campaign` via lazy `useState` initializers —
  // not in an effect. `CampaignBuilder` only ever mounts this step once
  // `campaign` has loaded (see its loading/not-found gates), so there is no
  // "campaign arrives later" case to handle here. The point of doing this in
  // the initializer rather than an effect: an effect's `setState` calls are
  // batched into a LATER render, so on the very first render (and especially
  // under StrictMode's mount/unmount/remount) `currentPayload` below would be
  // computed from pre-seed defaults — and if the unmount-flush effect's
  // cleanup fires before that later render lands, it persists that pre-seed
  // payload, nulling out a real saved window. Seeding synchronously means
  // there IS no pre-seed render: the state is correct from the first paint,
  // so there is no ordering between "seeded" and "flushable" left to get
  // wrong. `useState(() => ...)` runs its initializer exactly once, so a
  // background refetch handing this component a new `campaign` object later
  // does not re-seed and clobber an in-progress edit either.
  const [mode, setMode] = useState<CampaignScheduleMode>(() => campaign.scheduleMode);
  const [hasStart, setHasStart] = useState(() => seedBound(campaign.startsAt, '09:00').has);
  const [startDate, setStartDate] = useState(() => seedBound(campaign.startsAt, '09:00').date);
  const [startTime, setStartTime] = useState(() => seedBound(campaign.startsAt, '09:00').time);
  const [hasEnd, setHasEnd] = useState(() => seedBound(campaign.endsAt, '23:59').has);
  const [endDate, setEndDate] = useState(() => seedBound(campaign.endsAt, '23:59').date);
  const [endTime, setEndTime] = useState(() => seedBound(campaign.endsAt, '23:59').time);
  const [bannerError, setBannerError] = useState<string | null>(null);

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

  const currentPayload: SchedulePayload | null = scheduleFieldError
    ? null
    : { scheduleMode: mode, startsAt: mode === 'window' ? startsAt : null, endsAt: mode === 'window' ? endsAt : null };

  // The last payload this component has either loaded from or successfully
  // written to the server — comparing against it is what stops a debounce
  // tick (or the unmount flush) from re-sending a no-op save.
  const lastPersistedRef = useRef<string>(JSON.stringify({
    scheduleMode: campaign.scheduleMode, startsAt: campaign.startsAt, endsAt: campaign.endsAt,
  }));
  // Always the latest computed payload, valid or not — read by the unmount
  // flush below, which runs with whatever closure it had at MOUNT time unless
  // it reads through a ref.
  const latestPayloadRef = useRef<SchedulePayload | null>(currentPayload);
  latestPayloadRef.current = currentPayload;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = (payload: SchedulePayload) => {
    const key = JSON.stringify(payload);
    if (key === lastPersistedRef.current) return;
    lastPersistedRef.current = key;
    setBannerError(null);
    updateMutation.mutate({ id: campaign.id, input: payload }, {
      onError: (err) => {
        // The save failed — un-mark it as persisted so the next tick (or the
        // unmount flush) retries rather than treating a lost write as done.
        lastPersistedRef.current = '';
        setBannerError(err instanceof Error ? err.message : 'Failed to save the schedule.');
      },
    });
  };

  // Debounced autosave while the merchant is actively editing.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!currentPayload) return undefined;
    debounceTimerRef.current = setTimeout(() => persist(currentPayload), AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, hasStart, startDate, startTime, hasEnd, endDate, endTime]);

  // Flush on unmount — the moment the merchant navigates away (Back/Next/a
  // Tab). Reads `latestPayloadRef` rather than a closed-over value, since an
  // effect with `[]` deps only ever sees its FIRST render's closure otherwise.
  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const pending = latestPayloadRef.current;
    if (pending) persist(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BlockStack gap="400">
      {(bannerError || updateMutation.error) && (
        <Banner tone="critical" onDismiss={() => setBannerError(null)}>
          {bannerError ?? updateMutation.error?.message}
        </Banner>
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
          footnote="Times are in your own timezone. Saved automatically as you go."
        />
      )}

      <InlineStack gap="150" blockAlign="center">
        {updateMutation.isPending && <Spinner accessibilityLabel="Saving schedule" size="small" />}
        <Text as="span" variant="bodySm" tone="subdued">
          {updateMutation.isPending ? 'Saving…' : 'Changes save automatically.'}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
