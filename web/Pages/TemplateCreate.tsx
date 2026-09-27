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
  Banner, BlockStack, Card, InlineGrid, Page, Select, Spinner, Text, TextField,
} from '@shopify/polaris';
import { useCreateDiscount, useTemplate } from '../templates/hooks';
import type { DiscountMethod } from '../templates/api';
import { TierFields } from '../templates/forms/TierFields';
import { getMetafieldSizeBytes, type TierFormData } from '../../src/lib/discountEngines/tier';
import { ScheduleCard } from '../components/ScheduleCard';
import { toUtcIso } from '../lib/schedule';

const MAX_CONFIG_BYTES = 10 * 1024;

/**
 * `template.defaults` is a JSON blob off a DB row, so its shape is only as good
 * as the row. `TierFields` does `value.tiers.map(...)` on it immediately — a row
 * missing `tiers` would white-screen this page rather than say what is wrong.
 * Checked, not cast: a bad row gets a Banner.
 */
function isTierFormData(defaults: Record<string, unknown>): boolean {
  return Array.isArray((defaults as { tiers?: unknown }).tiers);
}

export default function TemplateCreate() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useTemplate(slug);
  const template = data?.template;
  const isNotFound = error ? /failed: 404\b/.test(error.message) : false;

  const [title, setTitle] = useState('');
  // How the discount is triggered. The template decides the ENGINE; this only
  // decides whether a shopper needs a code, so both paths send the same config.
  const [method, setMethod] = useState<DiscountMethod>('automatic');
  const [code, setCode] = useState('');
  const [hasStart, setHasStart] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [hasEnd, setHasEnd] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('23:59');
  // Only the `tier` engine has a form body in Stage 1 (see brief). The state
  // is a discriminated union on `engine` — not a bare `TierFormData | null` —
  // so the engine tag and its form data travel together and a mismatched pair
  // is a compile error rather than a runtime one. Stage 2 widens this by
  // adding `{ engine: 'bundle'; data: BundleFormData }` and the `special`
  // equivalent (replacing their `data: null` arms below) once those forms
  // exist — never by loosening `data`'s type back to `unknown`.
  type FormState =
    | { engine: 'tier'; data: TierFormData }
    | { engine: 'bundle'; data: null }
    | { engine: 'special'; data: null };
  const [form, setForm] = useState<FormState | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);

  // Seed form state from `template.defaults` exactly once — react-query may
  // hand us a new object reference on a background refetch, and clobbering a
  // merchant's half-filled form is the bug this guard exists to prevent (see
  // BundleEditor's `initializedRef`).
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!template || initializedRef.current) return;
    setTitle(template.name);
    if (template.type === 'tier') {
      if (!isTierFormData(template.defaults)) {
        setDefaultsError(
          `The stored setup for "${template.name}" is incomplete, so this template can't be used. Contact support.`,
        );
      } else {
        setForm({ engine: 'tier', data: template.defaults as unknown as TierFormData });
      }
    } else {
      setForm({ engine: template.type, data: null });
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

  const configSizeBytes = form?.engine === 'tier' ? getMetafieldSizeBytes(form.data) : 0;
  const configTooLarge = configSizeBytes > MAX_CONFIG_BYTES;

  const canSave = form?.engine === 'tier'
    // Automatic discounts are named by their title; code discounts by their
    // code. Each method requires exactly the field it is named by.
    && (method === 'code' ? code.trim().length > 0 : title.trim().length > 0)
    && !scheduleFieldError
    && !configTooLarge;

  const handleCreate = async () => {
    if (!form || form.engine !== 'tier' || !startsAt) return;
    setBannerError(null);
    try {
      // Built per method rather than spread, so TypeScript narrows the union
      // and a code discount cannot be assembled without its code.
      const common = {
        slug: template.slug,
        startsAt,
        ...(endsAt ? { endsAt } : {}),
        form: form.data,
      };
      await createMutation.mutateAsync(
        method === 'code'
          ? { ...common, method: 'code', code: code.trim() }
          : { ...common, method: 'automatic', title: title.trim() },
      );
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
        {defaultsError && <Banner tone="critical">{defaultsError}</Banner>}
        {configTooLarge && (
          <Banner tone="warning">
            {`This discount's configuration is ${(configSizeBytes / 1024).toFixed(1)}KB, over the 10KB limit. Remove some tiers or products.`}
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          <BlockStack gap="400">
            <Card>
              {/* A code discount is titled by its code, the way Shopify's own
                  admin does it — so asking for a separate title here would be
                  asking for a name the server then discards. */}
              {method === 'automatic' && (
                <TextField
                  label="Title"
                  value={title}
                  onChange={setTitle}
                  autoComplete="off"
                  requiredIndicator
                  helpText="Shown internally and in Shopify admin's discount list."
                />
              )}
              <Select
                label="Method"
                options={[
                  { label: 'Automatic', value: 'automatic' },
                  { label: 'Discount code', value: 'code' },
                ]}
                value={method}
                onChange={(next) => setMethod(next as DiscountMethod)}
                helpText={method === 'automatic'
                  ? 'Applies at checkout on its own when the cart qualifies.'
                  : 'The shopper must enter this code at checkout.'}
              />
              {method === 'code' && (
                <TextField
                  label="Discount code"
                  value={code}
                  onChange={setCode}
                  autoComplete="off"
                  requiredIndicator
                  helpText="What the shopper types at checkout, e.g. SPRING20. This also names the discount, as it does in Shopify admin."
                />
              )}
            </Card>

            {form?.engine === 'tier' && (
              <>
                <TierFields
                  value={form.data}
                  onChange={(data) => setForm({ engine: 'tier', data })}
                />
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
