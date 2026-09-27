// web/Pages/CampaignBuilder.tsx
//
// The four-step campaign wizard: Discounts -> Bundles -> Schedule -> Summary.
// A VIEW over a Draft campaign, not a buffer in front of one — each step
// saves through `useUpdateCampaign` as the merchant acts (adding a discount,
// toggling a bundle, saving a schedule), so closing the tab never loses work.
// The step index is the only local state this shell owns; everything else is
// server state owned by react-query.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Banner, BlockStack, Button, Card, InlineStack, Page, Spinner, Tabs, Text, TextField,
} from '@shopify/polaris';
import { useCampaign, useUpdateCampaign } from '../campaigns/hooks';
import { DiscountsStep } from '../campaigns/steps/DiscountsStep';
import { BundlesStep } from '../campaigns/steps/BundlesStep';
import { ScheduleStep } from '../campaigns/steps/ScheduleStep';
import { SummaryStep } from '../campaigns/steps/SummaryStep';

const STEPS = ['Discounts', 'Bundles', 'Schedule', 'Summary'] as const;

export default function CampaignBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useCampaign(id);
  const campaign = data?.campaign;
  const isNotFound = error ? /failed: 404\b/.test(error.message) : false;

  const updateMutation = useUpdateCampaign();
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  // Seed the name field from the loaded campaign exactly once — a background
  // refetch (e.g. after a step saves) must not clobber a rename the merchant
  // is mid-typing. Mirrors BundleEditor's `initializedRef`.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!campaign || initializedRef.current) return;
    setName(campaign.name);
    initializedRef.current = true;
  }, [campaign]);

  // Not editable past Draft — the server enforces this too (PUT 409s), but
  // this UI shouldn't offer a wizard for a campaign that's already live.
  const isDraft = campaign?.status === 'Draft';

  const handleNameBlur = async () => {
    if (!campaign) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Campaign name cannot be empty.');
      setName(campaign.name);
      return;
    }
    setNameError(null);
    if (trimmed === campaign.name) return;
    try {
      await updateMutation.mutateAsync({ id: campaign.id, input: { name: trimmed } });
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to save the name.');
      setName(campaign.name);
    }
  };

  if (isLoading) {
    return (
      <Page title="Campaign builder" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spinner accessibilityLabel="Loading campaign" />
        </div>
      </Page>
    );
  }

  if (error && !isNotFound) {
    return (
      <Page title="Campaign builder" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <Banner tone="critical">{error.message}</Banner>
      </Page>
    );
  }

  if (!campaign) {
    return (
      <Page title="Campaign not found" backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}>
        <Card><Text as="p">This campaign doesn&apos;t exist. It may have been deleted.</Text></Card>
      </Page>
    );
  }

  const tabs = STEPS.map((label) => ({ id: label, content: label }));

  let stepBody;
  if (!isDraft) {
    stepBody = (
      <Banner tone="warning" title={`This campaign is ${campaign.status}`}>
        <p>Only a Draft campaign can be edited here. Clone it to make further changes.</p>
      </Banner>
    );
  } else if (stepIndex === 0) {
    stepBody = <DiscountsStep campaign={campaign} />;
  } else if (stepIndex === 1) {
    stepBody = <BundlesStep campaign={campaign} />;
  } else if (stepIndex === 2) {
    stepBody = <ScheduleStep campaign={campaign} />;
  } else {
    stepBody = <SummaryStep campaign={campaign} />;
  }

  return (
    <Page
      title="Campaign builder"
      backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}
    >
      <BlockStack gap="400">
        <Card>
          <TextField
            label="Campaign name"
            value={name}
            onChange={setName}
            onBlur={handleNameBlur}
            autoComplete="off"
            requiredIndicator
            error={nameError ?? undefined}
            disabled={!isDraft}
          />
        </Card>

        <Tabs
          tabs={tabs}
          selected={stepIndex}
          onSelect={setStepIndex}
          disclosureText="More steps"
        />

        {stepBody}

        {isDraft && (
          <InlineStack align="space-between">
            <Button
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              disabled={stepIndex === 0}
            >
              Back
            </Button>
            {stepIndex < STEPS.length - 1 && (
              <Button
                variant="primary"
                onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
              >
                Next
              </Button>
            )}
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}
