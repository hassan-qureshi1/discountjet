import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  useAddBundleCampaign,
  useBundleCampaign,
  useCartTransforms,
  useUpdateBundleCampaign,
} from '../store/useDiscountStore';
import type { BundleCampaignBundle } from '../types';
import { KeyValueList } from '../components/common/KeyValueList';
import { SymbolTile } from '../components/common/SymbolTile';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const dateOnly = (s: string) => s.split('  ')[0];

export default function BundleCampaignEditor() {
  const { id } = useParams();
  const existing = useBundleCampaign(id);
  const allBundles = useCartTransforms();
  const navigate = useNavigate();
  const isEdit = Boolean(existing);

  const [name, setName] = useState(existing?.name ?? 'Winter bedroom event');
  const [starts, setStarts] = useState(existing?.starts ?? '2026-08-01  00:00');
  const [ends, setEnds] = useState(existing?.ends ?? '2026-09-30  23:59');
  const [rows, setRows] = useState<BundleCampaignBundle[]>(
    existing?.bundles ?? [{ bundleId: 'b1', price: 899, compareAtPrice: 1057 }],
  );

  const bundleOf = (bundleId: string) => allBundles.find((b) => b.id === bundleId);
  const nameOf = (bundleId: string) => bundleOf(bundleId)?.name ?? bundleId;

  const addBundle = () => {
    const next = allBundles.find((b) => !rows.some((r) => r.bundleId === b.id));
    if (next) setRows((prev) => [...prev, { bundleId: next.id, price: next.price, compareAtPrice: next.sumOfItems }]);
  };
  const removeRow = (bundleId: string) => setRows((prev) => prev.filter((r) => r.bundleId !== bundleId));
  const setField = (bundleId: string, field: 'price' | 'compareAtPrice', value: string) =>
    setRows((prev) => prev.map((r) => (r.bundleId === bundleId ? { ...r, [field]: parseFloat(value) || 0 } : r)));

  const addBundleCampaign = useAddBundleCampaign();
  const updateBundleCampaign = useUpdateBundleCampaign();
  const saveCampaign = () => {
    const campaign = {
      id: existing?.id ?? `bc-${Date.now()}`,
      name,
      status: existing?.status ?? ('Scheduled' as const),
      starts,
      ends,
      bundles: rows,
    };
    if (existing) updateBundleCampaign(existing.id, campaign);
    else addBundleCampaign(campaign);
    navigate('/bundle-campaigns');
  };

  return (
    <Page
      backAction={{ content: 'Bundle campaigns', onAction: () => navigate('/bundle-campaigns') }}
      title={isEdit ? 'Edit bundle campaign' : 'Create bundle campaign'}
      subtitle="Schedule bundles over a window and set each bundle’s campaign price and compare-at price."
      primaryAction={{ content: 'Save campaign', onAction: saveCampaign }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate('/bundle-campaigns') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <TextField
              label="Campaign name"
              value={name}
              onChange={setName}
              autoComplete="off"
              helpText="Internal name for this scheduled group of bundles."
            />
          </Card>

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Bundles in this campaign
                </Text>
                <Badge>{`${rows.length}`}</Badge>
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                Each bundle uses these prices for the campaign window. Compare-at shows shoppers the saving.
              </Text>
              <Divider />
              {rows.map((row) => {
                const save = Math.max(0, row.compareAtPrice - row.price);
                return (
                  <Box key={row.bundleId} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center" wrap={false}>
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <SymbolTile symbol="⇄" size={28} />
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {nameOf(row.bundleId)}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              Base price {money(bundleOf(row.bundleId)?.price ?? row.price)}
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <Button variant="tertiary" tone="critical" onClick={() => removeRow(row.bundleId)} disabled={rows.length <= 1}>
                          Remove
                        </Button>
                      </InlineStack>

                      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                        <TextField
                          label="Campaign price"
                          type="number"
                          prefix="$"
                          value={String(row.price)}
                          onChange={(v) => setField(row.bundleId, 'price', v)}
                          autoComplete="off"
                          min={0}
                        />
                        <TextField
                          label="Compare-at price"
                          type="number"
                          prefix="$"
                          value={String(row.compareAtPrice)}
                          onChange={(v) => setField(row.bundleId, 'compareAtPrice', v)}
                          autoComplete="off"
                          min={0}
                          helpText="Shown struck through in the cart."
                        />
                      </InlineGrid>

                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Shoppers see
                        </Text>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {money(row.price)}
                        </Text>
                        {row.compareAtPrice > row.price && (
                          <Text as="span" variant="bodySm" tone="subdued" textDecorationLine="line-through">
                            {money(row.compareAtPrice)}
                          </Text>
                        )}
                        {save > 0 && <Badge tone="success">{`Save ${money(save)}`}</Badge>}
                      </InlineStack>
                    </BlockStack>
                  </Box>
                );
              })}
              <InlineStack>
                <Button onClick={addBundle} disabled={rows.length >= allBundles.length}>
                  Add bundle
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </BlockStack>

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Schedule
              </Text>
              <Divider />
              <TextField label="Starts at" value={starts} onChange={setStarts} autoComplete="off" />
              <TextField label="Ends at" value={ends} onChange={setEnds} autoComplete="off" />
              <Text as="span" variant="bodySm" tone="subdued">
                Times in store timezone (AEST). The app activates and deactivates the campaign automatically on the
                next cron pass (≤ 5 min).
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Summary
              </Text>
              <Divider />
              <KeyValueList
                items={[
                  { term: 'Bundles', description: String(rows.length) },
                  { term: 'Window', description: `${dateOnly(starts)} → ${dateOnly(ends)}` },
                  { term: 'Activation', description: 'Cron, ≤ 5 min after start' },
                  { term: 'Metafield', description: <code>$app:cart_transform</code> },
                ]}
              />
              <Text as="span" variant="bodySm" tone="subdued">
                When the window opens, each bundle’s price and compare-at price are written into the cart-transform
                metafield, and cleared when it closes.
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      </InlineGrid>
    </Page>
  );
}
