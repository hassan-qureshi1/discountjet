import { useNavigate } from 'react-router-dom';
import {
  Banner,
  BlockStack,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useCartTransforms } from '../store/useDiscountStore';
import type { CartTransformStatus, Tone } from '../types';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';

const STATUS_TONE: Record<CartTransformStatus, Tone> = {
  Active: 'success',
  Scheduled: 'info',
  Ended: 'neutral',
};

const metafieldTone = (metafield: string): Tone =>
  metafield === 'Written' ? 'success' : 'neutral';

export default function CartTransformation() {
  const transforms = useCartTransforms();
  const navigate = useNavigate();

  return (
    <Page
      title="Bundles"
      subtitle="Each campaign holds one or more bundles on a shared schedule. The canonical record lives in D1; the product metafield is its activated projection — written when the window opens, cleared when it closes."
      primaryAction={{ content: 'Create campaign', onAction: () => navigate('/bundles/new') }}
    >
      <BlockStack gap="400">
        <Card padding="0">
          <IndexTable
            resourceName={{ singular: 'campaign', plural: 'campaigns' }}
            itemCount={transforms.length}
            selectable={false}
            headings={[
              { title: 'Campaign' },
              { title: 'Bundles', alignment: 'end' },
              { title: 'Schedule' },
              { title: 'Status' },
              { title: 'Metafield' },
              { title: 'Updated' },
              { title: '' },
            ]}
          >
            {transforms.map((t, index) => (
              <IndexTable.Row id={t.id} key={t.id} position={index}>
                <IndexTable.Cell>
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <SymbolTile symbol="⇄" size={30} />
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {t.name}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {t.detail}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" numeric alignment="end">
                    {t.bundles}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" tone="subdued">
                    {t.schedule}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <StatusBadge tone={STATUS_TONE[t.status]} label={t.status} />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <StatusBadge tone={metafieldTone(t.metafield)} label={t.metafield} />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" tone="subdued">
                    {t.updated}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Button variant="plain" onClick={() => navigate(`/bundles/${t.id}/edit`)}>
                    Edit
                  </Button>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>

        <Banner tone="info" title="Why a schedule, not the function?">
          <p>
            Discounts get native start/end dates; bundles don’t, and a Shopify Function has
            no reliable clock. The cron owns time — presence of the metafield is what turns a
            bundle on and off. Same cron pass as limit enforcement, every 5 minutes.
          </p>
        </Banner>
      </BlockStack>
    </Page>
  );
}
