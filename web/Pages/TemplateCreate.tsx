// web/Pages/TemplateCreate.tsx
//
// The page a merchant lands on after picking a template from the gallery
// (web/Pages/Templates.tsx). Loads the template, seeds a form from its
// defaults, and on submit hands the form straight to POST /api/discounts —
// the server re-validates and builds the config; this page's own validation
// is fast feedback only. Shape follows web/Pages/BundleEditor.tsx.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Banner, BlockStack, Card, InlineGrid, Page, Spinner, Text, TextField,
} from '@shopify/polaris';
import { useCreateDiscount, useTemplate } from '../templates/hooks';
import { TierFields } from '../templates/forms/TierFields';
import { getMetafieldSizeBytes, type TierFormData } from '../../src/lib/discountEngines/tier';
import { ScheduleCard } from '../components/ScheduleCard';
import { toUtcIso } from '../lib/schedule';

const MAX_CONFIG_BYTES = 10 * 1024;

export default function TemplateCreate() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useTemplate(slug);
  const template = data?.template;
  const isNotFound = error ? /failed: 404\b/.test(error.message) : false;

  const [title, setTitle] = useState('');
  const [hasStart, setHasStart] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [hasEnd, setHasEnd] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('23:59');
  // Only the `tier` engine has a form body in Stage 1 (see brief). `form` is
  // left untyped here on purpose — its shape depends on `template.type`, and
  // only the tier branch below ever reads or writes it as `TierFormData`.
  const [form, setForm] = useState<TierFormData | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Seed form state from `template.defaults` exactly once — react-query may
  // hand us a new object reference on a background refetch, and clobbering a
  // merchant's half-filled form is the bug this guard exists to prevent (see
  // BundleEditor's `initializedRef`).
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!template || initializedRef.current) return;
    setTitle(template.name);
    if (template.type === 'tier') {
      setForm(template.defaults as unknown as TierFormData);
    }
    initializedRef.current = true;
  }, [template]);

  const createMutation = useCreateDiscount();

  if (isLoading) {
    return (
      <Page title="Create discount" backAction={{ url: '/templates' }}>
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spinner accessibilityLabel="Loading template" />
        </div>
      </Page>
    );
  }

  if (error && !isNotFound) {
    return (
      <Page title="Create discount" backAction={{ url: '/templates' }}>
        <Banner tone="critical">{error.message}</Banner>
      </Page>
    );
  }

  if (!template) {
    return (
      <Page title="Template not found" backAction={{ url: '/templates' }}>
        <Card>
          <Text as="p">This template doesn&apos;t exist, or is no longer available.</Text>
        </Card>
      </Page>
    );
  }

  // Converted once and reused for both the preview and the save, so what the
  // merchant is shown is exactly what gets sent.
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  let scheduleFieldError: string | null = null;
  try {
    if (hasStart && !startDate) {
      scheduleFieldError = 'Enter a start date, or clear "Set a start date" to leave it unscheduled.';
    } else if (hasEnd && !endDate) {
      scheduleFieldError = 'Enter an end date, or clear "Set an end date" to leave it unscheduled.';
    } else {
      startsAt = hasStart && startDate ? toUtcIso(startDate, startTime) : new Date().toISOString();
      if (hasEnd && endDate) endsAt = toUtcIso(endDate, endTime);
      if (endsAt && startsAt >= endsAt) {
        scheduleFieldError = 'The start must be before the end.';
      }
    }
  } catch {
    scheduleFieldError = 'Enter a valid date and time.';
  }

  const configSizeBytes = form ? getMetafieldSizeBytes(form) : 0;
  const configTooLarge = configSizeBytes > MAX_CONFIG_BYTES;

  const canSave = template.type === 'tier'
    && Boolean(form)
    && title.trim().length > 0
    && !scheduleFieldError
    && !configTooLarge;

  const handleCreate = async () => {
    if (!form || !startsAt) return;
    setBannerError(null);
    try {
      await createMutation.mutateAsync({
        slug: template.slug,
        title: title.trim(),
        startsAt,
        ...(endsAt ? { endsAt } : {}),
        form,
      });
      navigate('/discounts');
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to create the discount.');
    }
  };

  return (
    <Page
      title="Create discount"
      subtitle={template.name}
      backAction={{ url: '/templates' }}
      primaryAction={{
        content: 'Create discount',
        onAction: handleCreate,
        loading: createMutation.isPending,
        disabled: !canSave || createMutation.isPending,
      }}
    >
      <BlockStack gap="400">
        {(bannerError || createMutation.error) && (
          <Banner tone="critical" onDismiss={() => setBannerError(null)}>
            {bannerError ?? createMutation.error?.message}
          </Banner>
        )}
        {configTooLarge && (
          <Banner tone="warning">
            {`This discount's configuration is ${(configSizeBytes / 1024).toFixed(1)}KB, over the 10KB limit. Remove some tiers or products.`}
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          <BlockStack gap="400">
            <Card>
              <TextField
                label="Title"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                requiredIndicator
                helpText="Shown internally and in Shopify admin's discount list."
              />
            </Card>

            {template.type === 'tier' && form && (
              <>
                <TierFields value={form} onChange={setForm} />
                <Text as="span" variant="bodySm" tone={configTooLarge ? 'critical' : 'subdued'}>
                  {`${(configSizeBytes / 1024).toFixed(1)}KB of 10KB used`}
                </Text>
              </>
            )}

            {template.type !== 'tier' && (
              <Banner tone="warning">
                {`${template.name} isn't available yet — this template type arrives in a later stage.`}
              </Banner>
            )}
          </BlockStack>

          <BlockStack gap="400">
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
              startHelpText="Leave off to start as soon as it's created."
              endHelpText="Leave off to run until you turn it off in Shopify."
            />
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
