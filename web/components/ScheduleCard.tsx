import type { ReactNode } from 'react';
import {
  Banner, BlockStack, Card, Checkbox, InlineGrid, InlineStack, Text, TextField,
} from '@shopify/polaris';
import { StatusBadge } from './StatusBadge';
import type { Tone } from '../types/discounts';

/**
 * An optional start/end window, held as the merchant typed it — local date and
 * local time, not an instant. Converting to UTC is the caller's job
 * (`web/lib/schedule.ts`), because only the caller knows what it is about to
 * send and when.
 */
export interface ScheduleWindow {
  hasStart: boolean;
  startDate: string;
  startTime: string;
  hasEnd: boolean;
  endDate: string;
  endTime: string;
}

export interface ScheduleCardProps {
  value: ScheduleWindow;
  onChange: (next: ScheduleWindow) => void;
  /** Badge in the header — the status this window implies right now. */
  status?: { label: string; tone: Tone };
  /** Blocking validation message for the window itself. */
  error?: string | null;
  /** A previous scheduled transition that failed, surfaced as a warning. */
  lastFailure?: string | null;
  /**
   * Renders every field read-only and suppresses `onChange` — for a bundle
   * whose window is owned by a still-live campaign. The campaign, not this
   * form, is the source of truth for the window in that case; `bannerSlot`
   * is how the caller names the owner and links to it.
   */
  disabled?: boolean;
  /** Extra content rendered above the fields — e.g. the campaign-lock Banner. */
  bannerSlot?: ReactNode;
  /** Copy. Defaults are deliberately noun-free so this card is not about bundles. */
  title?: string;
  startHelpText?: string;
  endHelpText?: string;
  footnote?: string;
  lastFailureTitle?: string;
  lastFailureDetail?: string;
}

/**
 * A start/end scheduling window, for anything that goes live and comes down on
 * a timetable — bundles today, campaigns next.
 *
 * Deliberately stateless: it renders `value` and reports edits through
 * `onChange`, so the page that owns the form owns the state. That is also what
 * lets the same card sit on a page whose schedule is one field among many.
 */
export function ScheduleCard({
  value,
  onChange,
  status,
  error,
  lastFailure,
  disabled = false,
  bannerSlot,
  title = 'Schedule',
  startHelpText = 'Leave off to start as soon as it is saved.',
  endHelpText = 'Leave off to run until you switch it off.',
  footnote = 'Times are in your own timezone.',
  lastFailureTitle = 'The last scheduled change did not go through',
  lastFailureDetail = 'It will be retried automatically. Saving also retries it.',
}: ScheduleCardProps) {
  const set = (patch: Partial<ScheduleWindow>) => {
    if (disabled) return;
    onChange({ ...value, ...patch });
  };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingSm">{title}</Text>
          {status && <StatusBadge label={status.label} tone={status.tone} />}
        </InlineStack>

        {bannerSlot}

        <Checkbox
          label="Set a start date"
          checked={value.hasStart}
          onChange={(hasStart) => set({ hasStart })}
          helpText={startHelpText}
          disabled={disabled}
        />
        {value.hasStart && (
          <InlineGrid columns={2} gap="300">
            <TextField
              label="Start date"
              type="date"
              value={value.startDate}
              onChange={(startDate) => set({ startDate })}
              autoComplete="off"
              disabled={disabled}
            />
            <TextField
              label="Start time"
              type="time"
              value={value.startTime}
              onChange={(startTime) => set({ startTime })}
              autoComplete="off"
              disabled={disabled}
            />
          </InlineGrid>
        )}

        <Checkbox
          label="Set an end date"
          checked={value.hasEnd}
          onChange={(hasEnd) => set({ hasEnd })}
          helpText={endHelpText}
          disabled={disabled}
        />
        {value.hasEnd && (
          <InlineGrid columns={2} gap="300">
            <TextField
              label="End date"
              type="date"
              value={value.endDate}
              onChange={(endDate) => set({ endDate })}
              autoComplete="off"
              disabled={disabled}
            />
            <TextField
              label="End time"
              type="time"
              value={value.endTime}
              onChange={(endTime) => set({ endTime })}
              autoComplete="off"
              disabled={disabled}
            />
          </InlineGrid>
        )}

        {error && <Banner tone="critical">{error}</Banner>}

        <Text as="p" variant="bodySm" tone="subdued">{footnote}</Text>

        {lastFailure && (
          <Banner tone="warning" title={lastFailureTitle}>
            <p>{lastFailure}</p>
            <p>{lastFailureDetail}</p>
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}
