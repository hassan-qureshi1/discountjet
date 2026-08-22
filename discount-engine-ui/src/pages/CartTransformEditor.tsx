import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  List,
  Page,
  ProgressBar,
  Select,
  Tag,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCartTransform, usePlan, useShop } from '../store/useDiscountStore';
import type { CartTransformOp } from '../types';
import { ChoiceCard } from '../components/common/ChoiceCard';
import { KeyValueList } from '../components/common/KeyValueList';
import {
  CART_TRANSFORM_LIMITS,
  gateField,
  gateOperation,
  getOp,
  MAX_EXPAND_QTY,
  OPERATIONS,
  type AppTier,
  type GateResult,
} from '../components/discount/cartTransformOps';

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

/** One selectable operation, disabled + badged when the plan/tier locks it. */
function OperationCard({
  label,
  description,
  selected,
  gate,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  gate: GateResult;
  onSelect: () => void;
}) {
  const locked = !gate.enabled;
  return (
    <div
      onClick={() => !locked && onSelect()}
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--p-color-border)',
        cursor: locked ? 'not-allowed' : 'pointer',
        opacity: locked ? 0.6 : 1,
        boxShadow: selected && !locked ? 'inset 0 0 0 2px var(--p-color-border-brand)' : undefined,
      }}
    >
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <InlineStack gap="150" blockAlign="center">
          <div
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              flex: '0 0 auto',
              border: `2px solid ${selected && !locked ? 'var(--p-color-border-brand)' : 'var(--p-color-border-strong)'}`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {selected && !locked && (
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--p-color-bg-fill-brand)' }} />
            )}
          </div>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {label}
          </Text>
        </InlineStack>
        <InlineStack gap="150">
          {locked && gate.reasons.map((r) => <Badge key={r} tone="warning">{r}</Badge>)}
        </InlineStack>
      </InlineStack>
      <div style={{ paddingLeft: 24, marginTop: 2 }}>
        <Text as="span" variant="bodySm" tone="subdued">
          {description}
        </Text>
      </div>
    </div>
  );
}

interface Component {
  id: number;
  name: string;
  qty: string;
}

export default function CartTransformEditor() {
  const { id } = useParams();
  const existing = useCartTransform(id);
  const plan = usePlan();
  const shop = useShop();
  const navigate = useNavigate();
  const isEdit = Boolean(existing);

  const appTier = plan.current as AppTier;
  const shopifyPlus = shop.shopifyPlan === 'Plus';
  const advGate = gateField('Scale', appTier); // title/image override, per-component pricing

  const [operation, setOperation] = useState<CartTransformOp>(existing?.operation ?? 'merge');
  const [name, setName] = useState(existing?.name ?? 'Winter bedroom bundle');
  const [items, setItems] = useState<string[]>(existing?.items ?? ['Oak Bed Frame — Queen', 'Memory Foam Pillow ×2']);
  const [price, setPrice] = useState(String(existing?.price ?? 899));
  const [parent, setParent] = useState(CATALOGUE[0].name);
  const [components, setComponents] = useState<Component[]>([
    { id: 1, name: 'Memory Foam Pillow ×2', qty: '2' },
    { id: 2, name: 'Bamboo Sheet Set', qty: '1' },
  ]);
  const [schedule, setSchedule] = useState(existing?.status === 'Active' ? 0 : 1);
  const [starts, setStarts] = useState('2026-08-01  00:00');
  const [ends, setEnds] = useState('2026-09-30  23:59');

  const addVariant = () => {
    const next = CATALOGUE.find((c) => !items.includes(c.name));
    if (next) setItems((prev) => [...prev, next.name]);
  };
  const removeVariant = (n: string) => setItems((prev) => prev.filter((x) => x !== n));

  const addComponent = () => {
    const next = CATALOGUE.find((c) => !components.some((k) => k.name === c.name));
    if (next) setComponents((prev) => [...prev, { id: Date.now(), name: next.name, qty: '1' }]);
  };
  const updateComponentQty = (cid: number, qty: string) =>
    setComponents((prev) => prev.map((c) => (c.id === cid ? { ...c, qty } : c)));
  const removeComponent = (cid: number) => setComponents((prev) => prev.filter((c) => c.id !== cid));

  const sumOfItems = items.reduce((sum, n) => sum + priceOf(n), 0);
  const priceNum = parseFloat(price) || 0;
  const save = Math.max(0, sumOfItems - priceNum);

  const catalogueOptions = CATALOGUE.map((c) => ({ label: c.name, value: c.name }));

  return (
    <Page
      backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}
      title={isEdit ? 'Edit bundle' : 'Create bundle'}
      subtitle="A bundle runs one Shopify cart-transform operation at checkout — merge, expand, or update."
      titleMetadata={<Badge>{`${appTier} plan · ${shop.shopifyPlan}`}</Badge>}
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

          {/* Operation selector — gated by app tier + Shopify plan */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Cart transform operation
              </Text>
              {OPERATIONS.map((op) => (
                <OperationCard
                  key={op.id}
                  label={op.label}
                  description={op.description}
                  selected={operation === op.id}
                  gate={gateOperation(op, appTier, shopifyPlus)}
                  onSelect={() => setOperation(op.id)}
                />
              ))}
              <Banner tone="info" title="Cart transform limits">
                <List>
                  {CART_TRANSFORM_LIMITS.map((l) => (
                    <List.Item key={l}>{l}</List.Item>
                  ))}
                </List>
              </Banner>
            </BlockStack>
          </Card>

          {/* ── MERGE ── */}
          {operation === 'merge' && (
            <>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Merged variants
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    These cart lines are merged into one bundle line at checkout.
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
                      No variants yet.
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
                    <TextField label="Bundle price" type="number" prefix="$" value={price} onChange={setPrice} autoComplete="off" min={0} />
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

              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      Cart line override
                    </Text>
                    {!advGate.enabled && <Badge tone="warning">{advGate.reasons[0]}</Badge>}
                  </InlineStack>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <TextField label="Cart line title" placeholder="e.g. Winter Bedroom Bundle" value="" onChange={() => undefined} autoComplete="off" disabled={!advGate.enabled} />
                    <TextField label="Cart line image URL" placeholder="https://…" value="" onChange={() => undefined} autoComplete="off" disabled={!advGate.enabled} />
                  </InlineGrid>
                </BlockStack>
              </Card>
            </>
          )}

          {/* ── EXPAND ── */}
          {operation === 'expand' && (
            <>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Parent product
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    The line a shopper adds; it expands into the components below at checkout.
                  </Text>
                  <Select label="Parent variant" labelHidden options={catalogueOptions} value={parent} onChange={setParent} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      Components
                    </Text>
                    <Badge>{`${components.length} lines`}</Badge>
                  </InlineStack>
                  <Divider />
                  {components.map((c) => (
                    <InlineGrid key={c.id} columns={{ xs: 1, sm: 3 }} gap="300">
                      <Select
                        label="Variant"
                        options={catalogueOptions}
                        value={c.name}
                        onChange={(v) => setComponents((prev) => prev.map((k) => (k.id === c.id ? { ...k, name: v } : k)))}
                      />
                      <TextField
                        label="Quantity"
                        type="number"
                        value={c.qty}
                        onChange={(v) => updateComponentQty(c.id, v)}
                        min={1}
                        max={MAX_EXPAND_QTY}
                        autoComplete="off"
                        helpText={`Max ${MAX_EXPAND_QTY.toLocaleString('en-US')}`}
                      />
                      <BlockStack gap="100">
                        <InlineStack gap="150" blockAlign="center">
                          <Text as="span" variant="bodyMd">
                            Price adjustment
                          </Text>
                          {!advGate.enabled && <Badge tone="warning">{advGate.reasons[0]}</Badge>}
                        </InlineStack>
                        <InlineStack gap="200" blockAlign="center">
                          <div style={{ flex: 1 }}>
                            <TextField label="Price adjustment" labelHidden type="number" suffix="%" placeholder="0" value="" onChange={() => undefined} disabled={!advGate.enabled} autoComplete="off" />
                          </div>
                          <Button variant="tertiary" tone="critical" onClick={() => removeComponent(c.id)} disabled={components.length <= 1}>
                            Remove
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </InlineGrid>
                  ))}
                  <InlineStack>
                    <Button onClick={addComponent}>Add component</Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </>
          )}

          {/* ── UPDATE ── (reachable only on Scale + Shopify Plus) ── */}
          {operation === 'update' && (
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Line override
                </Text>
                <Select label="Target variant" options={catalogueOptions} value={parent} onChange={setParent} />
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <TextField label="New price" type="number" prefix="$" value="" onChange={() => undefined} autoComplete="off" />
                  <TextField label="New title" value="" onChange={() => undefined} autoComplete="off" />
                  <TextField label="New image URL" placeholder="https://…" value="" onChange={() => undefined} autoComplete="off" />
                </InlineGrid>
              </BlockStack>
            </Card>
          )}
        </BlockStack>

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Schedule
              </Text>
              <Divider />
              <ChoiceCard title="Activate immediately" helpText="Metafield written on the next cron pass (≤ 5 min)." selected={schedule === 0} onChange={() => setSchedule(0)} />
              <ChoiceCard title="Schedule a window" helpText="The app activates and deactivates the bundle automatically." selected={schedule === 1} onChange={() => setSchedule(1)} />
              {schedule === 1 && (
                <InlineGrid columns={2} gap="300">
                  <TextField label="Starts at" value={starts} onChange={setStarts} autoComplete="off" />
                  <TextField label="Ends at" value={ends} onChange={setEnds} autoComplete="off" />
                </InlineGrid>
              )}
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
                  { term: 'Operation', description: <Badge>{getOp(operation).label}</Badge> },
                  { term: 'Access', description: 'MERCHANT_READ' },
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
