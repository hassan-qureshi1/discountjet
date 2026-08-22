import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  ProgressBar,
  Tag,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCartTransform } from '../store/useDiscountStore';
import { ChoiceCard } from '../components/common/ChoiceCard';
import { KeyValueList } from '../components/common/KeyValueList';

// Sample catalogue (stands in for the variant picker) with per-item prices so
// the "sum of items" and saving update live as the merchant edits the bundle.
// Prices chosen so each seeded bundle's items sum to its sumOfItems in the data.
const CATALOGUE: { name: string; price: number }[] = [
  { name: 'Oak Bed Frame — Queen', price: 699 },
  { name: 'Memory Foam Pillow ×2', price: 358 },
  { name: 'Bamboo Sheet Set', price: 149 },
  { name: 'Duvet Cover', price: 89 },
  { name: 'Cloud Hybrid Mattress — Queen', price: 1221 },
  { name: 'Mattress Protector', price: 89 },
  { name: '3-Seat Sofa', price: 899 },
  { name: 'Scatter Cushion ×2', price: 79 },
  { name: 'Wool Throw', price: 252 },
];
const priceOf = (name: string) => CATALOGUE.find((c) => c.name === name)?.price ?? 0;
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CartTransformEditor() {
  const { id } = useParams();
  const existing = useCartTransform(id);
  const navigate = useNavigate();
  const isEdit = Boolean(existing);

  const [name, setName] = useState(existing?.name ?? 'Winter bedroom bundle');
  const [items, setItems] = useState<string[]>(existing?.items ?? ['Oak Bed Frame — Queen', 'Memory Foam Pillow ×2']);
  const [price, setPrice] = useState(String(existing?.price ?? 899));
  const [schedule, setSchedule] = useState(existing?.status === 'Active' ? 0 : 1);
  const [starts, setStarts] = useState('2026-08-01  00:00');
  const [ends, setEnds] = useState('2026-09-30  23:59');

  const addVariant = () => {
    const next = CATALOGUE.find((c) => !items.includes(c.name));
    if (next) setItems((prev) => [...prev, next.name]);
  };
  const removeVariant = (name: string) => setItems((prev) => prev.filter((n) => n !== name));

  const sumOfItems = items.reduce((sum, n) => sum + priceOf(n), 0);
  const priceNum = parseFloat(price) || 0;
  const save = Math.max(0, sumOfItems - priceNum);

  return (
    <Page
      backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}
      title={isEdit ? 'Edit bundle' : 'Create bundle'}
      subtitle="A bundle is a set of variants the cart-transformer assembles at checkout and sells at one price."
      primaryAction={{ content: 'Save bundle' }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate('/bundles') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <TextField
              label="Bundle name"
              value={name}
              onChange={setName}
              autoComplete="off"
              helpText="Shown internally and used to label the bundle in the metafield."
            />
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Bundle items
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                The variants that make up this bundle — the cart-transformer assembles it from them at
                checkout.
              </Text>
              {items.length > 0 ? (
                <InlineStack gap="150">
                  {items.map((item) => (
                    <Tag key={item} onRemove={() => removeVariant(item)}>
                      {item}
                    </Tag>
                  ))}
                </InlineStack>
              ) : (
                <Text as="span" variant="bodySm" tone="subdued">
                  No items yet — add the variants that form this bundle.
                </Text>
              )}
              <InlineStack>
                <Button onClick={addVariant} disabled={items.length >= CATALOGUE.length}>
                  Add variants
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Price
              </Text>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField
                  label="Bundle price"
                  type="number"
                  prefix="$"
                  value={price}
                  onChange={setPrice}
                  autoComplete="off"
                  min={0}
                />
                <BlockStack gap="100">
                  <Text as="span" variant="bodyMd">
                    Sum of items
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodyMd" tone="subdued" textDecorationLine="line-through">
                      {money(sumOfItems)}
                    </Text>
                    {save > 0 && <Badge tone="success">{`Save ${money(save)}`}</Badge>}
                  </InlineStack>
                </BlockStack>
              </InlineGrid>
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
                helpText="The app activates and deactivates the bundle automatically."
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
                  { term: 'Contains', description: `${items.length} variant${items.length === 1 ? '' : 's'}` },
                  {
                    term: 'Status',
                    description: <Badge tone={existing?.metafield === 'Written' ? 'success' : undefined}>{existing?.metafield ?? 'Not yet written'}</Badge>,
                  },
                ]}
              />
              <BlockStack gap="150">
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Serialized size
                  </Text>
                  <Text as="span" variant="bodySm" numeric>
                    0.9 kB / 10 kB
                  </Text>
                </InlineStack>
                <ProgressBar progress={9} size="small" tone="success" />
              </BlockStack>
            </BlockStack>
          </Card>
        </BlockStack>
      </InlineGrid>
    </Page>
  );
}
