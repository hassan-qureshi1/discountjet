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
  Checkbox,
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
import {
  useAddCampaign,
  useAddDiscount,
  useCampaign,
  useCampaignTemplates,
  useCartTransforms,
} from '../store/useDiscountStore';
import { DISCOUNT_TYPE_LABEL } from '../types';
import { Stepper } from '../components/common/Stepper';
import { ChoiceCard } from '../components/common/ChoiceCard';
import { EmailTagField } from '../components/common/EmailTagField';
import { KeyValueList } from '../components/common/KeyValueList';
import { SymbolTile } from '../components/common/SymbolTile';
import { DiscountSetupForm, type BuiltDiscount } from '../components/discount/DiscountSetupForm';

const STEPS = ['Details', 'Discounts', 'Bundles', 'Schedule', 'Review'];

interface CampaignDiscount extends BuiltDiscount {
  rowId: string;
}

// Merchant-friendly type buttons → the engine kind the setup wizard expects.
const TYPE_BUTTONS: { label: string; kind: string }[] = [
  { label: '＋ Volume discount', kind: 'Tier' },
  { label: '＋ Buy X, get Y', kind: 'Bundle' },
  { label: '＋ Buy X, discount both', kind: 'Split' },
];

const dateOnly = (s: string) => s.split('  ')[0];
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

export default function CampaignBuilder() {
  const { id } = useParams();
  const existing = useCampaign(id);
  const templates = useCampaignTemplates();
  const allBundles = useCartTransforms();
  const addCampaign = useAddCampaign();
  const addDiscount = useAddDiscount();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [name, setName] = useState(existing?.name ?? 'Winter bedroom event');
  const [description, setDescription] = useState('Bedding push for the cold-weather promo window.');
  const [buildMethod, setBuildMethod] = useState(0);
  const [schedule, setSchedule] = useState(1);
  const [starts, setStarts] = useState('2026-09-01  00:00');
  const [ends, setEnds] = useState('2026-09-30  23:59');
  const [discounts, setDiscounts] = useState<CampaignDiscount[]>([]);
  const [bundleIds, setBundleIds] = useState<string[]>([]);
  const [csvFiles, setCsvFiles] = useState<File[]>([]);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const [notifyEmails, setNotifyEmails] = useState<string[]>(['marketing@evahome.com']);

  // Add-discount modal (full discount-ui wizard, same as the Discounts flow).
  const [discountModalKind, setDiscountModalKind] = useState<string | null>(null);
  const [pendingBuilt, setPendingBuilt] = useState<BuiltDiscount>({ name: 'New discount', type: 'Tier', symbol: '%', products: 0 });
  const [bundleModalOpen, setBundleModalOpen] = useState(false);
  const [bundleSelection, setBundleSelection] = useState<string[]>([]);

  const applyTemplate = (templateId: string) => {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    setName(t.name);
    setDescription(t.description);
    setPrefilledFrom(t.name);
    setBuildMethod(1);
    setTemplateModalOpen(false);
  };

  const openDiscountModal = (kind: string) => {
    setPendingBuilt({ name: 'New discount', type: 'Tier', symbol: '%', products: 0 });
    setDiscountModalKind(kind);
  };
  const addPendingDiscount = () => {
    setDiscounts((d) => [...d, { rowId: `cd-${Date.now()}`, ...pendingBuilt }]);
    setDiscountModalKind(null);
  };
  const removeDiscount = (rowId: string) => setDiscounts((d) => d.filter((x) => x.rowId !== rowId));

  const chosenBundles = bundleIds.map((bid) => allBundles.find((b) => b.id === bid)).filter(Boolean);
  const availableBundles = allBundles.filter((b) => !bundleIds.includes(b.id));
  const openBundleModal = () => {
    setBundleSelection([]);
    setBundleModalOpen(true);
  };
  const toggleBundleSelection = (bid: string) =>
    setBundleSelection((sel) => (sel.includes(bid) ? sel.filter((x) => x !== bid) : [...sel, bid]));
  const confirmAddBundles = () => {
    setBundleIds((ids) => [...ids, ...bundleSelection]);
    setBundleSelection([]);
    setBundleModalOpen(false);
  };

  const isLast = step === STEPS.length - 1;

  const publish = () => {
    const campaignId = `c-${Date.now()}`;
    const window = schedule === 1 ? `${dateOnly(starts)} → ${dateOnly(ends)}` : 'Immediate';
    addCampaign({
      id: campaignId,
      name,
      detail: `${discounts.length} discounts · ${bundleIds.length} bundles`,
      discounts: discounts.length,
      bundles: bundleIds.length,
      revenue: null,
      orders: null,
      discount: null,
      schedule: window,
      status: schedule === 1 ? 'Scheduled' : 'Published',
    });
    // Campaign-created discounts appear in Discounts, locked to this campaign.
    discounts.forEach((row, i) => {
      addDiscount({
        id: `d-${Date.now()}-${i}`,
        name: row.name,
        symbol: row.symbol,
        type: row.type,
        status: 'Active',
        products: row.products,
        updated: 'just now',
        campaignId,
      });
    });
    navigate('/campaigns');
  };

  return (
    <Page
      backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}
      title={existing ? 'Edit campaign' : 'Create campaign'}
      subtitle="Build a campaign step by step. Save a draft any time; publish when you’re ready to go live."
      titleMetadata={<Badge tone="warning">Draft</Badge>}
    >
      <BlockStack gap="400">
        <Stepper steps={STEPS} current={step} onSelect={setStep} />

        {/* STEP 0 · Details */}
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
                <TextField label="Campaign name" value={name} onChange={setName} autoComplete="off" helpText="Internal name — groups every discount and bundle campaign on this schedule." />
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
                    <DropZone accept=".csv,text/csv" type="file" onDrop={(_drop, accepted) => setCsvFiles(accepted)}>
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
                      Expected columns: campaign, section, type, name, products, value, min_qty, bundle_price, starts_at, ends_at.
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
            <Banner tone="info" title="Nothing goes live yet">
              <p>The campaign stays a draft while you build. No Shopify discounts are created until you publish on the Review step.</p>
            </Banner>
          </BlockStack>
        )}

        {/* STEP 1 · Discounts */}
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
              {discounts.length > 0 ? (
                discounts.map((row) => (
                  <Box key={row.rowId} padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <SymbolTile symbol={row.symbol} size={32} brand />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {row.name}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {DISCOUNT_TYPE_LABEL[row.type]} · {row.products} products
                        </Text>
                      </BlockStack>
                      <Box width="100%">
                        <InlineStack align="end" gap="200" blockAlign="center">
                          <Badge tone="magic">{DISCOUNT_TYPE_LABEL[row.type]}</Badge>
                          <Button tone="critical" variant="tertiary" onClick={() => removeDiscount(row.rowId)}>
                            Remove
                          </Button>
                        </InlineStack>
                      </Box>
                    </InlineStack>
                  </Box>
                ))
              ) : (
                <Text as="span" variant="bodySm" tone="subdued">
                  No discounts yet. Add one below — you choose the products and prices in the setup that opens.
                </Text>
              )}
              <InlineStack gap="200" wrap>
                {TYPE_BUTTONS.map((b) => (
                  <Button key={b.kind} onClick={() => openDiscountModal(b.kind)}>
                    {b.label}
                  </Button>
                ))}
                <Button variant="plain" onClick={() => navigate('/campaigns/templates')}>
                  Add from template
                </Button>
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                Each discount is created in Shopify via the GraphQL Admin API on publish, and appears in Discounts locked to this campaign.
              </Text>
            </BlockStack>
          </Card>
        )}

        {/* STEP 2 · Bundles (choose from existing) */}
        {step === 2 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Bundles
                </Text>
                <Badge tone="info">{`${bundleIds.length} bundles`}</Badge>
              </InlineStack>
              <Divider />
              {chosenBundles.length > 0 ? (
                chosenBundles.map(
                  (b) =>
                    b && (
                      <Box key={b.id} padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <SymbolTile symbol="⇄" size={30} />
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {b.name}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {b.items.slice(0, 2).join(' · ')} · {money(b.price)}
                            </Text>
                          </BlockStack>
                          <Box width="100%">
                            <InlineStack align="end">
                              <Button tone="critical" variant="tertiary" onClick={() => setBundleIds((ids) => ids.filter((x) => x !== b.id))}>
                                Remove
                              </Button>
                            </InlineStack>
                          </Box>
                        </InlineStack>
                      </Box>
                    ),
                )
              ) : (
                <Text as="span" variant="bodySm" tone="subdued">
                  No bundles yet. Add ones you’ve already created in the Bundles page.
                </Text>
              )}
              <InlineStack>
                <Button onClick={openBundleModal} disabled={availableBundles.length === 0}>
                  Add bundles
                </Button>
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                Bundles are defined in the Bundles page. Add existing ones here to include them in the campaign.
              </Text>
            </BlockStack>
          </Card>
        )}

        {/* STEP 3 · Schedule */}
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
              <EmailTagField
                label="Notify marketing when the schedule triggers"
                value={notifyEmails}
                onChange={setNotifyEmails}
                helpText="We email these people when the campaign activates and when it deactivates."
              />
            </BlockStack>
          </Card>
        )}

        {/* STEP 4 · Review */}
        {step === 4 && (
          <BlockStack gap="400">
            <Banner tone="warning" title="Publishing is one-way">
              <p>
                Publish creates <b>{discounts.length} discount{discounts.length === 1 ? '' : 's'} in Shopify via the GraphQL Admin API</b> and schedules the bundles.
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
                  {discounts.length > 0 ? (
                    discounts.map((row) => (
                      <InlineStack key={row.rowId} gap="300" blockAlign="center" wrap={false}>
                        <SymbolTile symbol={row.symbol} size={28} brand />
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {row.name}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {DISCOUNT_TYPE_LABEL[row.type]} · {row.products} products
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    ))
                  ) : (
                    <Text as="span" variant="bodySm" tone="subdued">
                      No discounts added.
                    </Text>
                  )}
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
                      { term: 'Bundles', description: chosenBundles.length ? chosenBundles.map((b) => b?.name).join(', ') : 'None' },
                      { term: 'Window', description: schedule === 1 ? `${dateOnly(starts)} → ${dateOnly(ends)} (AEST)` : 'Immediate on publish' },
                      { term: 'Notify', description: notifyEmails.length ? notifyEmails.join(', ') : '—' },
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

        {/* Wizard footer */}
        <InlineStack align="space-between" blockAlign="center">
          <Button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            ‹ Back
          </Button>
          <ButtonGroup>
            <Button onClick={() => navigate('/campaigns')}>Save draft</Button>
            {isLast ? (
              <Button variant="primary" tone="success" onClick={publish}>
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

      {/* Template picker modal */}
      <Modal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title="Choose a campaign template">
        <Modal.Section>
          <BlockStack gap="200">
            {templates.map((t) => (
              <div
                key={t.id}
                onClick={() => applyTemplate(t.id)}
                style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--p-color-border)', cursor: 'pointer' }}
              >
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <div
                    aria-hidden
                    style={{ width: 40, height: 40, borderRadius: 10, display: 'grid', placeItems: 'center', fontSize: 20, flex: '0 0 auto', background: 'var(--p-color-bg-surface-brand)', boxShadow: 'inset 0 0 0 1px var(--p-color-border)' }}
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
                  </BlockStack>
                </InlineStack>
              </div>
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Add-discount modal — full discount setup, same as the Discounts flow */}
      <Modal
        open={discountModalKind !== null}
        onClose={() => setDiscountModalKind(null)}
        title="Add discount to campaign"
        primaryAction={{ content: 'Add to campaign', onAction: addPendingDiscount }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDiscountModalKind(null) }]}
      >
        <Modal.Section>
          {discountModalKind && (
            <DiscountSetupForm kind={discountModalKind} defaultTitle="New discount" onChange={setPendingBuilt} />
          )}
        </Modal.Section>
      </Modal>

      {/* Bundle picker modal — select multiple bundles at once */}
      <Modal
        open={bundleModalOpen}
        onClose={() => setBundleModalOpen(false)}
        title="Add bundles"
        primaryAction={{
          content: bundleSelection.length ? `Add ${bundleSelection.length} bundle${bundleSelection.length === 1 ? '' : 's'}` : 'Add bundles',
          disabled: bundleSelection.length === 0,
          onAction: confirmAddBundles,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setBundleModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            {availableBundles.length === 0 ? (
              <Text as="span" variant="bodySm" tone="subdued">
                All your bundles are already in this campaign.
              </Text>
            ) : (
              <>
                <Text as="span" variant="bodySm" tone="subdued">
                  Select the bundles to add to this campaign.
                </Text>
                {availableBundles.map((b) => {
                  const checked = bundleSelection.includes(b.id);
                  return (
                    <div
                      key={b.id}
                      onClick={() => toggleBundleSelection(b.id)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid var(--p-color-border)',
                        cursor: 'pointer',
                        boxShadow: checked ? 'inset 0 0 0 2px var(--p-color-border-brand)' : undefined,
                      }}
                    >
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <Checkbox label="" labelHidden checked={checked} onChange={() => toggleBundleSelection(b.id)} />
                        <SymbolTile symbol="⇄" size={30} />
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {b.name}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {b.items.slice(0, 2).join(' · ')} · {money(b.price)}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </div>
                  );
                })}
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
