import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  DropZone,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  ProgressBar,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCampaign, useCampaignTemplates } from '../store/useDiscountStore';
import { Stepper } from '../components/common/Stepper';
import { ChoiceCard } from '../components/common/ChoiceCard';
import { KeyValueList } from '../components/common/KeyValueList';
import { SymbolTile } from '../components/common/SymbolTile';

const STEPS = ['Details', 'Discounts', 'Bundles', 'Schedule', 'Review'];

interface DiscountRow {
  id: number;
  symbol: string;
  name: string;
  detail: string;
  type: string;
}

const INITIAL_DISCOUNTS: DiscountRow[] = [
  { id: 1, symbol: '%', name: 'Buy 2 Pillows, save 15%', detail: '15% off · min qty 2 · 4 variants', type: 'Tier' },
  { id: 2, symbol: '◱', name: 'Mattress + Base bundle', detail: 'Source + target · save $158', type: 'Bundle' },
];

export default function CampaignBuilder() {
  const { id } = useParams();
  const existing = useCampaign(id);
  const templates = useCampaignTemplates();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [name, setName] = useState(existing?.name ?? 'Winter bedroom event');
  const [description, setDescription] = useState('Bedding push for the cold-weather promo window.');
  const [buildMethod, setBuildMethod] = useState(0);
  const [schedule, setSchedule] = useState(1);
  const [starts, setStarts] = useState('2026-09-01  00:00');
  const [ends, setEnds] = useState('2026-09-30  23:59');
  const [discounts, setDiscounts] = useState<DiscountRow[]>(INITIAL_DISCOUNTS);
  const [csvFiles, setCsvFiles] = useState<File[]>([]);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const [notifyEmails, setNotifyEmails] = useState('marketing@evahome.com');

  const applyTemplate = (templateId: string) => {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    setName(t.name);
    setDescription(t.description);
    setPrefilledFrom(t.name);
    setBuildMethod(1);
    setTemplateModalOpen(false);
  };

  const removeDiscount = (rid: number) => setDiscounts((d) => d.filter((x) => x.id !== rid));
  const addDiscount = (type: string, symbol: string) =>
    setDiscounts((d) => [...d, { id: Date.now(), symbol, name: `New ${type.toLowerCase()} discount`, detail: 'Configure on publish', type }]);

  const isLast = step === STEPS.length - 1;

  return (
    <Page
      backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}
      title={existing ? 'Edit campaign' : 'Create campaign'}
      subtitle="Build a campaign step by step. Save a draft any time; publish when you’re ready to go live."
      titleMetadata={<Badge tone="warning">Draft</Badge>}
    >
      <BlockStack gap="400">
        <Stepper steps={STEPS} current={step} onSelect={setStep} />

        {step === 0 && (
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                {prefilledFrom && (
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="success">{`Prefilled from “${prefilledFrom}”`}</Badge>
                    <Button variant="plain" onClick={() => setTemplateModalOpen(true)}>
                      Change template
                    </Button>
                  </InlineStack>
                )}
                <TextField label="Campaign name" value={name} onChange={setName} autoComplete="off" helpText="Internal name — groups every discount and bundle on this schedule." />
                <TextField label="Description (internal, optional)" value={description} onChange={setDescription} autoComplete="off" multiline={2} />
                <BlockStack gap="150">
                  <Text as="span" variant="bodyMd">
                    How do you want to build it?
                  </Text>
                  <ChoiceCard title="Build manually" helpText="Add discounts and bundles yourself in the next steps." selected={buildMethod === 0} onChange={() => setBuildMethod(0)} />
                  <ChoiceCard title="Start from a template" helpText="Prefill from a ready-made campaign, then tweak." selected={buildMethod === 1} onChange={() => setTemplateModalOpen(true)} />
                  <ChoiceCard title="Import from CSV" helpText="Upload a full campaign — discounts, bundles and schedule." selected={buildMethod === 2} onChange={() => setBuildMethod(2)} />
                </BlockStack>

                {buildMethod === 2 && (
                  <BlockStack gap="200">
                    <DropZone
                      accept=".csv,text/csv"
                      type="file"
                      onDrop={(_drop, accepted) => setCsvFiles(accepted)}
                    >
                      {csvFiles.length > 0 ? (
                        <Box padding="400">
                          <BlockStack gap="150">
                            {csvFiles.map((file) => (
                              <InlineStack key={file.name} gap="200" blockAlign="center">
                                <Badge tone="success">CSV</Badge>
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                  {file.name}
                                </Text>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {`${Math.max(1, Math.round(file.size / 1024))} kB`}
                                </Text>
                              </InlineStack>
                            ))}
                          </BlockStack>
                        </Box>
                      ) : (
                        <DropZone.FileUpload actionTitle="Add CSV file" actionHint="or drop a .csv here to upload" />
                      )}
                    </DropZone>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Expected columns: campaign, section, type, name, products, value, min_qty, bundle_price,
                      starts_at, ends_at.
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
            <Banner tone="info" title="Nothing goes live yet">
              <p>The campaign stays a draft in D1 while you build. No Shopify discounts are created until you publish on the Review step.</p>
            </Banner>
          </BlockStack>
        )}

        {step === 1 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Discounts
                </Text>
                <Badge tone="info">{`${discounts.length} discounts`}</Badge>
              </InlineStack>
              <Divider />
              {discounts.map((row) => (
                <Box key={row.id} padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <SymbolTile symbol={row.symbol} size={32} brand />
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {row.name}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {row.detail}
                      </Text>
                    </BlockStack>
                    <Box width="100%">
                      <InlineStack align="end" gap="200" blockAlign="center">
                        <Badge tone="info">{row.type}</Badge>
                        <Button tone="critical" variant="tertiary" onClick={() => removeDiscount(row.id)}>
                          Remove
                        </Button>
                      </InlineStack>
                    </Box>
                  </InlineStack>
                </Box>
              ))}
              <InlineStack gap="200" wrap>
                <Button onClick={() => addDiscount('Tier', '%')}>＋ Tier discount</Button>
                <Button onClick={() => addDiscount('Bundle', '◱')}>＋ Bundle discount</Button>
                <Button onClick={() => addDiscount('Special', '◨')}>＋ Special discount</Button>
                <Button variant="plain" onClick={() => navigate('/campaigns/templates')}>
                  Add from template
                </Button>
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                Each discount is created in Shopify via the GraphQL Admin API on publish.
              </Text>
            </BlockStack>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Bundles
                </Text>
                <Badge tone="info">1 bundle</Badge>
              </InlineStack>
              <Divider />
              <Box padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Badge tone="magic">Bundle 1</Badge>
                    <div style={{ flex: 1 }}>
                      <TextField label="Bundle name" labelHidden value="Bed frame + 2 pillows" onChange={() => undefined} autoComplete="off" />
                    </div>
                  </InlineStack>
                  <InlineStack gap="150">
                    <Badge>Oak Bed Frame — Queen</Badge>
                    <Badge>Memory Foam Pillow — Std ×2</Badge>
                  </InlineStack>
                  <TextField label="Bundle price" prefix="$" value="899.00" onChange={() => undefined} autoComplete="off" />
                </BlockStack>
              </Box>
              <InlineStack>
                <Button>＋ Add bundle</Button>
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                Optional. Bundles are assembled at checkout by the Rust cart-transformer and written into the app metafield when the campaign activates.
              </Text>
            </BlockStack>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Schedule
              </Text>
              <Divider />
              <ChoiceCard title="Activate immediately on publish" helpText="Discounts created and metafield written on the next cron pass (≤ 5 min)." selected={schedule === 0} onChange={() => setSchedule(0)} />
              <ChoiceCard title="Schedule a window" helpText="The app activates and deactivates the whole campaign automatically." selected={schedule === 1} onChange={() => setSchedule(1)} />
              {schedule === 1 && (
                <InlineGrid columns={2} gap="300">
                  <TextField label="Starts at" value={starts} onChange={setStarts} autoComplete="off" />
                  <TextField label="Ends at" value={ends} onChange={setEnds} autoComplete="off" />
                </InlineGrid>
              )}
              <Divider />
              <TextField
                label="Notify marketing when the schedule triggers"
                type="email"
                value={notifyEmails}
                onChange={setNotifyEmails}
                autoComplete="off"
                placeholder="marketing@evahome.com, ops@evahome.com"
                helpText="Comma-separated. We email these people when the campaign activates and when it deactivates."
              />
            </BlockStack>
          </Card>
        )}

        {step === 4 && (
          <BlockStack gap="400">
            <Banner tone="warning" title="Publishing is one-way">
              <p>
                Publish creates <b>discounts in Shopify via the GraphQL Admin API</b> and schedules the bundle metafield.
                Once live, this campaign is locked — to change it, clone it into a new draft.
              </p>
            </Banner>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      Discounts
                    </Text>
                    <Badge tone="info">{String(discounts.length)}</Badge>
                  </InlineStack>
                  <Divider />
                  {discounts.map((row) => (
                    <InlineStack key={row.id} gap="300" blockAlign="center" wrap={false}>
                      <SymbolTile symbol={row.symbol} size={28} brand />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {row.name}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {row.type} · {row.detail}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Bundles &amp; schedule
                  </Text>
                  <Divider />
                  <KeyValueList
                    items={[
                      { term: 'Bundles', description: '1 (Bed frame + 2 pillows)' },
                      { term: 'Window', description: `${starts.split('  ')[0]} → ${ends.split('  ')[0]} (AEST)` },
                      { term: 'Activation', description: 'Cron, ≤ 5 min after start' },
                      { term: 'Notify', description: notifyEmails || '—' },
                      { term: 'Metafield', description: <code>$app:cart_transform</code> },
                    ]}
                  />
                  <BlockStack gap="150">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Serialized size
                      </Text>
                      <Text as="span" variant="bodySm" numeric>
                        2.4 kB / 10 kB
                      </Text>
                    </InlineStack>
                    <ProgressBar progress={24} size="small" tone="success" />
                  </BlockStack>
                </BlockStack>
              </Card>
            </InlineGrid>
          </BlockStack>
        )}

        <InlineStack align="space-between" blockAlign="center">
          <Button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            ‹ Back
          </Button>
          <ButtonGroup>
            <Button onClick={() => navigate('/campaigns')}>Save draft</Button>
            {isLast ? (
              <Button variant="primary" tone="success" onClick={() => navigate('/campaigns')}>
                Publish campaign
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
                Next ›
              </Button>
            )}
          </ButtonGroup>
        </InlineStack>
      </BlockStack>

      <Modal
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        title="Choose a campaign template"
      >
        <Modal.Section>
          <BlockStack gap="200">
            {templates.map((t) => (
              <div
                key={t.id}
                onClick={() => applyTemplate(t.id)}
                style={{
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid var(--p-color-border)',
                  cursor: 'pointer',
                }}
              >
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <div
                    aria-hidden
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 10,
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 20,
                      flex: '0 0 auto',
                      background: 'var(--p-color-bg-surface-brand)',
                      boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
                    }}
                  >
                    {t.emoji}
                  </div>
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {t.name}
                      </Text>
                      <Badge>{t.category}</Badge>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t.description}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t.example}
                    </Text>
                  </BlockStack>
                  <Box width="100%">
                    <InlineStack align="end">
                      <Text as="span" variant="bodyLg" tone="subdued">
                        ›
                      </Text>
                    </InlineStack>
                  </Box>
                </InlineStack>
              </div>
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
