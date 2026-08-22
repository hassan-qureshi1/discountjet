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
  ProgressBar,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCartTransform } from '../store/useDiscountStore';
import { ChoiceCard } from '../components/common/ChoiceCard';
import { KeyValueList } from '../components/common/KeyValueList';

interface BundleDraft {
  id: number;
  name: string;
  items: string[];
  price: string;
}

const INITIAL_BUNDLES: BundleDraft[] = [
  { id: 1, name: 'Bed frame + 2 pillows', items: ['Oak Bed Frame — Queen', 'Memory Foam Pillow — Std ×2'], price: '899.00' },
  { id: 2, name: 'Mattress + protector + sheets', items: ['Cloud Hybrid Mattress — Queen', 'Mattress Protector'], price: '' },
];

export default function CartTransformEditor() {
  const { id } = useParams();
  const existing = useCartTransform(id);
  const navigate = useNavigate();
  const isEdit = Boolean(existing);

  const [name, setName] = useState(existing?.name ?? 'Winter bedroom bundles');
  const [schedule, setSchedule] = useState(1); // 0 immediate, 1 window
  const [starts, setStarts] = useState('2026-08-01  00:00');
  const [ends, setEnds] = useState('2026-09-30  23:59');
  const [bundles, setBundles] = useState<BundleDraft[]>(INITIAL_BUNDLES);

  const addBundle = () =>
    setBundles((b) => [...b, { id: Date.now(), name: '', items: [], price: '' }]);
  const removeBundle = (bid: number) => setBundles((b) => b.filter((x) => x.id !== bid));
  const setBundleName = (bid: number, value: string) =>
    setBundles((b) => b.map((x) => (x.id === bid ? { ...x, name: value } : x)));
  const setBundlePrice = (bid: number, value: string) =>
    setBundles((b) => b.map((x) => (x.id === bid ? { ...x, price: value } : x)));

  return (
    <Page
      backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}
      title={isEdit ? 'Edit campaign' : 'Create campaign'}
      subtitle="A campaign is a scheduled set of bundles. Each bundle is assembled from its variants at checkout by the cart-transformer."
      primaryAction={{ content: 'Save campaign' }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate('/bundles') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <TextField
              label="Campaign name"
              value={name}
              onChange={setName}
              autoComplete="off"
              helpText="Groups all the bundles that share this schedule."
            />
          </Card>

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Bundles
                </Text>
                <Badge tone="info">{`${bundles.length} bundles`}</Badge>
              </InlineStack>
              <Divider />
              {bundles.map((bundle, i) => (
                <Box key={bundle.id} padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                  <BlockStack gap="300">
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <Badge tone="magic">{`Bundle ${i + 1}`}</Badge>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Bundle name"
                          labelHidden
                          value={bundle.name}
                          onChange={(v) => setBundleName(bundle.id, v)}
                          autoComplete="off"
                          placeholder="Bundle name"
                        />
                      </div>
                      <Button tone="critical" variant="tertiary" onClick={() => removeBundle(bundle.id)}>
                        Remove
                      </Button>
                    </InlineStack>

                    <BlockStack gap="150">
                      <Text as="span" variant="bodySm">
                        Bundle items
                      </Text>
                      {bundle.items.length > 0 ? (
                        <InlineStack gap="150">
                          {bundle.items.map((item) => (
                            <Badge key={item}>{item}</Badge>
                          ))}
                        </InlineStack>
                      ) : (
                        <Button>Add variants</Button>
                      )}
                    </BlockStack>

                    <TextField
                      label="Bundle price"
                      type="number"
                      prefix="$"
                      value={bundle.price}
                      onChange={(v) => setBundlePrice(bundle.id, v)}
                      autoComplete="off"
                      placeholder="0.00"
                    />
                  </BlockStack>
                </Box>
              ))}
              <InlineStack>
                <Button onClick={addBundle}>＋ Add bundle</Button>
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                Each bundle groups multiple variants; the Rust cart-transformer assembles it from them at checkout.
              </Text>
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
              <ChoiceCard
                title="Activate immediately"
                helpText="Metafield written on the next cron pass (≤ 5 min)."
                selected={schedule === 0}
                onChange={() => setSchedule(0)}
              />
              <ChoiceCard
                title="Schedule a window"
                helpText="App activates and deactivates automatically."
                selected={schedule === 1}
                onChange={() => setSchedule(1)}
              />
              {schedule === 1 && (
                <InlineGrid columns={2} gap="300">
                  <TextField label="Starts at" value={starts} onChange={setStarts} autoComplete="off" />
                  <TextField label="Ends at" value={ends} onChange={setEnds} autoComplete="off" />
                </InlineGrid>
              )}
              <Text as="span" variant="bodySm" tone="subdued">
                Times in store timezone (AEST). Activation is only as precise as the cron cadence.
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Metafield
                </Text>
                <Badge tone="info">App-owned · read-only</Badge>
              </InlineStack>
              <Divider />
              <KeyValueList
                items={[
                  { term: 'Namespace', description: <code>$app:cart_transform</code> },
                  { term: 'Key', description: <code>config</code> },
                  { term: 'Access', description: 'MERCHANT_READ' },
                  { term: 'Contains', description: 'All bundles in this campaign' },
                  { term: 'Status', description: <Badge tone="success">Written · Aug 1</Badge> },
                ]}
              />
              <BlockStack gap="150">
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Serialized size
                  </Text>
                  <Text as="span" variant="bodySm" numeric>
                    3.1 kB / 10 kB
                  </Text>
                </InlineStack>
                <ProgressBar progress={31} size="small" tone="success" />
              </BlockStack>
              <Text as="span" variant="bodySm" tone="subdued">
                All bundles serialize into one config. Shopify drops metafields over 10 kB — D1 stays canonical.
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      </InlineGrid>
    </Page>
  );
}
