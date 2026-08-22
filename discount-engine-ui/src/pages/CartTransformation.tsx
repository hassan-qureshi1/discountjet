import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Tabs,
  Text,
} from '@shopify/polaris';
import { useCartTransforms } from '../store/useDiscountStore';
import type { CartTransform, CartTransformOp, CartTransformStatus, Tone } from '../types';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';
import { getOp } from '../components/discount/cartTransformOps';

const OP_TONE: Record<CartTransformOp, 'info' | 'magic' | 'warning'> = {
  merge: 'info',
  expand: 'magic',
  update: 'warning',
};

const STATUS_TONE: Record<CartTransformStatus, Tone> = {
  Active: 'success',
  Scheduled: 'info',
  Ended: 'neutral',
};

const metafieldTone = (metafield: string): Tone => (metafield === 'Written' ? 'success' : 'neutral');
const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const itemSummary = (items: string[]) =>
  items.slice(0, 2).join(' · ') + (items.length > 2 ? ` · +${items.length - 2}` : '');

type FilterId = 'all' | 'active' | 'scheduled' | 'ended';
const MATCHERS: Record<FilterId, (b: CartTransform) => boolean> = {
  all: () => true,
  active: (b) => b.status === 'Active',
  scheduled: (b) => b.status === 'Scheduled',
  ended: (b) => b.status === 'Ended',
};

export default function CartTransformation() {
  const bundles = useCartTransforms();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);

  const count = (id: FilterId) => bundles.filter(MATCHERS[id]).length;
  const filters: { id: FilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'ended', label: 'Ended' },
  ];
  const tabs = filters.map((f) => ({ id: f.id, content: f.label, badge: String(count(f.id)) }));
  const rows = bundles.filter(MATCHERS[filters[selected].id]);

  return (
    <Page
      title="Bundles"
      subtitle="Sell a set of variants together at a bundle price. Each bundle activates on its own schedule — the app writes a metafield when the window opens and clears it when it closes."
      primaryAction={{ content: 'Create bundle', onAction: () => navigate('/bundles/new') }}
    >
      <BlockStack gap="400">
        <InlineStack gap="200" blockAlign="center">
          <Badge tone="success">{`${count('active')} Active`}</Badge>
          <Badge tone="info">{`${count('scheduled')} Scheduled`}</Badge>
          <Badge>{`${count('ended')} Ended`}</Badge>
        </InlineStack>

        <Card padding="0">
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected}>
            <IndexTable
              resourceName={{ singular: 'bundle', plural: 'bundles' }}
              itemCount={rows.length}
              selectable={false}
              emptyState={
                <EmptyState
                  heading="No bundles here yet"
                  action={{ content: 'Create bundle', onAction: () => navigate('/bundles/new') }}
                  image=""
                >
                  <p>Bundle a few variants together and schedule when they go live.</p>
                </EmptyState>
              }
              headings={[
                { title: 'Bundle' },
                { title: 'Operation' },
                { title: 'Price', alignment: 'end' },
                { title: 'Save', alignment: 'end' },
                { title: 'Schedule' },
                { title: 'Status' },
                { title: 'Metafield' },
                { title: '' },
              ]}
            >
              {rows.map((b, index) => (
                <IndexTable.Row id={b.id} key={b.id} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <SymbolTile symbol="⇄" size={30} />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {b.name}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {itemSummary(b.items)}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={OP_TONE[b.operation]}>{getOp(b.operation).label}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end" fontWeight="semibold">
                      {money(b.price)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div style={{ textAlign: 'right' }}>
                      <Badge tone="success">{`−${money(b.sumOfItems - b.price)}`}</Badge>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">
                      {b.schedule}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <StatusBadge tone={STATUS_TONE[b.status]} label={b.status} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <StatusBadge tone={metafieldTone(b.metafield)} label={b.metafield} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button variant="plain" onClick={() => navigate(`/bundles/${b.id}/edit`)}>
                      Edit
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Tabs>
        </Card>

        <Banner tone="info" title="Why a schedule, not the function?">
          <p>
            Discounts get native start/end dates; bundles don’t, and a Shopify Function has no
            reliable clock. The cron owns time — presence of the metafield is what turns a bundle on
            and off. Same cron pass as limit enforcement, every 5 minutes.
          </p>
        </Banner>
      </BlockStack>
    </Page>
  );
}
