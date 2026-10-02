// web/campaigns/steps/DiscountsStep.tsx
//
// Step 1 of the campaign builder. A table of the campaign's discounts, with
// Add (opens `TierFields` in a Modal) and Remove. Only the `tier` engine is
// authorable in this slice, matching E5's Stage 1 — a `bundle` or `special`
// row can still be REMOVED here (it came from somewhere, e.g. a clone of a
// published campaign) but is never editable, so it gets a warning Banner
// instead of a broken form.
//
// Every Add/Remove writes straight through `useUpdateCampaign` — the table
// always reflects `campaign.discounts`, never a local buffer, so closing the
// tab after adding one discount does not lose it.
import { useState } from 'react';
import {
  Badge, Banner, BlockStack, Button, Card, IndexTable, InlineStack, Modal, Select, Text, TextField,
} from '@shopify/polaris';
import type {
  Campaign, CampaignDiscount, CampaignDiscountInput, CampaignDiscountMethod,
} from '../api';
import { useUpdateCampaign } from '../hooks';
import { useTemplates } from '../../templates/hooks';
import { TierFields } from '../../templates/forms/TierFields';
import {
  getMetafieldSizeBytes, METAFIELD_MAX_SIZE_BYTES, newTier, type TierFormData,
} from '../../../src/lib/discountEngines/tier';

const ENGINE_LABEL: Record<CampaignDiscount['type'], string> = {
  tier: 'Tiered quantity',
  bundle: 'Bundle price',
  special: 'Special',
};

const METHOD_LABEL: Record<CampaignDiscountMethod, string> = {
  automatic: 'Automatic',
  code: 'Discount code',
};

function blankTierForm(): TierFormData {
  return {
    message: '',
    applyTo: 'price',
    discountType: 'percentage',
    productDiscountSelectionStrategy: 'ALL',
    platform: 'BOTH',
    tiers: [newTier()],
  };
}

/** The read row round-tripped back into what a save sends — unmodified rows
 * ride along verbatim so a PUT (which replaces the whole array) doesn't drop
 * them. `configJson` is stored as a JSON STRING on the read side; the write
 * side wants the parsed form back (see `CampaignDiscountInput.configJson`). */
function toInput(row: CampaignDiscount): CampaignDiscountInput {
  let configJson: unknown;
  try {
    configJson = JSON.parse(row.configJson);
  } catch {
    // A row whose stored config isn't valid JSON can't be round-tripped
    // faithfully; sending the raw string is honest about what's there rather
    // than silently dropping the row.
    configJson = row.configJson;
  }
  return {
    type: row.type,
    method: row.method,
    ...(row.code ? { code: row.code } : {}),
    name: row.name,
    configJson,
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export function DiscountsStep({ campaign }: { campaign: Campaign }) {
  const updateMutation = useUpdateCampaign();
  const { data: templatesData } = useTemplates();
  const tierTemplates = (templatesData?.templates ?? []).filter((t) => t.type === 'tier');

  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [method, setMethod] = useState<CampaignDiscountMethod>('automatic');
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [templateSlug, setTemplateSlug] = useState<string>('blank');
  const [form, setForm] = useState<TierFormData>(blankTierForm());

  const nonTierRows = campaign.discounts.filter((d) => d.type !== 'tier');
  // A clone numbers its discount titles so the copy can publish at all: the
  // source's are already live in Shopify under the originals, and Shopify
  // refuses a duplicate title. The number keeps it publishable; it does not
  // make it a good name, and only the merchant knows what this one is for.
  // Matched on the counted suffix rather than a stored flag, so nothing has to
  // be remembered about how the campaign came to exist.
  const copiedRows = campaign.discounts.filter((d) => / \(\d+\)$/.test(d.name));

  const openModal = () => {
    setModalError(null);
    setMethod('automatic');
    setTitle('');
    setCode('');
    setTemplateSlug('blank');
    setForm(blankTierForm());
    setModalOpen(true);
  };

  const applyTemplate = (slug: string) => {
    setTemplateSlug(slug);
    if (slug === 'blank') {
      setForm(blankTierForm());
      return;
    }
    const template = tierTemplates.find((t) => t.slug === slug);
    if (!template) return;
    if (!Array.isArray((template.defaults as { tiers?: unknown }).tiers)) {
      setModalError(`The stored setup for "${template.name}" is incomplete, so it can't seed this discount.`);
      return;
    }
    setModalError(null);
    setTitle(template.name);
    setForm(template.defaults as unknown as TierFormData);
  };

  const configSizeBytes = getMetafieldSizeBytes(form);
  const configTooLarge = configSizeBytes > METAFIELD_MAX_SIZE_BYTES;
  const canAdd = (method === 'code' ? code.trim().length > 0 : title.trim().length > 0) && !configTooLarge;

  const handleAdd = async () => {
    if (!canAdd) return;
    setModalError(null);
    const next: CampaignDiscountInput = {
      type: 'tier',
      method,
      ...(method === 'code' ? { code: code.trim() } : {}),
      name: method === 'code' ? code.trim() : title.trim(),
      configJson: form,
    };
    const discounts = [...campaign.discounts.map(toInput), next];
    try {
      await updateMutation.mutateAsync({ id: campaign.id, input: { discounts } });
      setModalOpen(false);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to add the discount.');
    }
  };

  const handleRemove = async (id: string) => {
    const discounts = campaign.discounts.filter((d) => d.id !== id).map(toInput);
    await updateMutation.mutateAsync({ id: campaign.id, input: { discounts } });
  };

  return (
    <BlockStack gap="400">
      {updateMutation.error && !modalOpen && (
        <Banner tone="critical">{updateMutation.error.message}</Banner>
      )}
      {copiedRows.length > 0 && (
        <Banner tone="warning" title="Rename these before publishing">
          <p>
            {`${copiedRows.map((d) => d.name).join(', ')} — copied from another campaign, `}
            whose discounts already exist in Shopify under the original names.
            Shopify requires a discount title to be unique, so these were given a
            number to keep them publishable. Give them names that mean something
            to you before you publish.
          </p>
        </Banner>
      )}
      {nonTierRows.length > 0 && (
        <Banner tone="warning" title="Some discounts aren't editable in this slice">
          <p>
            {`${nonTierRows.map((d) => d.name).join(', ')} — this campaign type isn't authorable here yet. `}
            You can still remove it below.
          </p>
        </Banner>
      )}

      <Card padding="0">
        <IndexTable
          resourceName={{ singular: 'discount', plural: 'discounts' }}
          itemCount={campaign.discounts.length}
          selectable={false}
          headings={[
            { title: 'Name' },
            { title: 'Engine' },
            { title: 'Method' },
            { title: 'Config size', alignment: 'end' },
            { title: '' },
          ]}
        >
          {campaign.discounts.map((d, index) => (
            <IndexTable.Row id={d.id} key={d.id} position={index}>
              <IndexTable.Cell>
                <Text as="span" fontWeight="semibold">{d.name}</Text>
              </IndexTable.Cell>
              <IndexTable.Cell>{ENGINE_LABEL[d.type]}</IndexTable.Cell>
              <IndexTable.Cell>{METHOD_LABEL[d.method]}</IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack align="end">
                  <Text as="span" numeric alignment="end">{formatBytes(d.configBytes)}</Text>
                </InlineStack>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack align="end">
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => handleRemove(d.id)}
                    disabled={updateMutation.isPending}
                    accessibilityLabel={`Remove ${d.name}`}
                  >
                    Remove
                  </Button>
                </InlineStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
        {campaign.discounts.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <Text as="p" tone="subdued">No discounts yet. Add one to get started.</Text>
          </div>
        )}
      </Card>

      <InlineStack>
        <Button onClick={openModal}>Add discount</Button>
      </InlineStack>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add a discount"
        primaryAction={{
          content: 'Add discount',
          onAction: handleAdd,
          loading: updateMutation.isPending,
          disabled: !canAdd || updateMutation.isPending,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false), disabled: updateMutation.isPending }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {modalError && <Banner tone="critical">{modalError}</Banner>}

            <Select
              label="Start from a template"
              options={[
                { label: 'Blank', value: 'blank' },
                ...tierTemplates.map((t) => ({ label: t.name, value: t.slug })),
              ]}
              value={templateSlug}
              onChange={applyTemplate}
              helpText="Seeds the fields below. You can still change everything."
            />

            <Select
              label="Method"
              options={[
                { label: 'Automatic', value: 'automatic' },
                { label: 'Discount code', value: 'code' },
              ]}
              value={method}
              onChange={(next) => setMethod(next as CampaignDiscountMethod)}
            />
            {method === 'automatic' ? (
              <TextField
                label="Title"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                requiredIndicator
              />
            ) : (
              <TextField
                label="Discount code"
                value={code}
                onChange={setCode}
                autoComplete="off"
                requiredIndicator
                helpText="What the shopper types at checkout. This also names the discount."
              />
            )}

            <TierFields value={form} onChange={setForm} />

            <InlineStack align="space-between">
              <Text as="span" variant="bodySm" tone={configTooLarge ? 'critical' : 'subdued'}>
                {`${formatBytes(configSizeBytes)} of ${formatBytes(METAFIELD_MAX_SIZE_BYTES)} used`}
              </Text>
              {configTooLarge && <Badge tone="critical">Over the limit</Badge>}
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}
