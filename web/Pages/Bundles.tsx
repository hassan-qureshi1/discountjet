import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBridge } from '@shopify/app-bridge-react';
import {
  Badge, Banner, BlockStack, Box, Button, ButtonGroup, Card, IndexTable, InlineGrid, InlineStack, Page, Spinner, Text,
} from '@shopify/polaris';
import { useActivationQuery, useBundlesQuery, useShopPlanQuery } from '../bundles/hooks';
import { fetchBundleAdminUrl } from '../bundles/api';
import { getOp } from '../bundles/ops';
import type { Bundle, BundleOperation } from '../types/bundles';
import { SymbolTile } from '../components/SymbolTile';
import { CreateBundleAction } from '../components/CreateBundleAction';
import { createAuthenticatedFetch } from '../api';
import { formatMoney, moneyAmount } from '../lib/money';

const OP_TONE: Record<BundleOperation, 'info' | 'magic' | 'warning'> = {
  merge: 'info',
  expand: 'magic',
  update: 'warning',
};

/** A small row of generic package tiles standing in for a bundle's items (no product names available). */
function ItemThumbs({ count }: { count: number }) {
  const shown = Math.min(count, 4);
  const extra = count - shown;
  return (
    <InlineStack gap="100" blockAlign="center">
      {Array.from({ length: shown }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            flex: '0 0 auto',
            background: 'var(--p-color-bg-surface-secondary)',
            boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
          }}
        >
          📦
        </div>
      ))}
      {extra > 0 && (
        <Text as="span" variant="bodySm" tone="subdued">
          +
          {extra}
        </Text>
      )}
    </InlineStack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box padding="400">
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="headingLg" fontWeight="bold">
          {value}
        </Text>
      </BlockStack>
    </Box>
  );
}

export default function Bundles() {
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);
  const { data, isLoading, error } = useBundlesQuery();
  const { data: activation, error: activationError } = useActivationQuery();
  const { data: planData } = useShopPlanQuery();
  const [viewError, setViewError] = useState<string | null>(null);

  const bundles = data?.bundles ?? [];
  const summary = data?.summary ?? { count: 0, inCampaigns: 0, avgSaving: null };

  const handleViewInShopify = async (bundleId: string) => {
    setViewError(null);
    try {
      const res = await fetchBundleAdminUrl(fetcher, bundleId);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setViewError(`Couldn't open this bundle in Shopify: ${message}`);
    }
  };

  return (
    <Page
      title="Bundles"
      subtitle="Define a bundle once — the variants it merges or expands, and its base price. Schedule it and set campaign prices in a bundle campaign."
      primaryAction={(
        <CreateBundleAction
          updateOpEligible={planData?.updateOpEligible ?? false}
          // The operation rides in the URL rather than in router state, so the
          // choice survives a refresh, a back-navigation and a shared link —
          // and the editor has no hidden precondition for opening correctly.
          onSelect={(operation) => navigate(`/bundles/new?operation=${operation}`)}
        />
      )}
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical">{error.message}</Banner>}
        {activation?.conflict && (
          <Banner tone="warning">
            Another app already controls this store&apos;s cart transform, so bundles can&apos;t be activated.
            Remove the other app&apos;s cart transform to use bundles.
          </Banner>
        )}
        {!activation?.conflict && (activationError || (activation && activation.active === false && activation.error)) && (
          <Banner tone="warning">
            Couldn&apos;t activate bundles automatically. Make sure the cart-transform function is deployed.
            {activation?.error ? ` (${activation.error})` : null}
          </Banner>
        )}
        {activation?.active === true && (
          <Banner tone="success">Bundles active.</Banner>
        )}
        {viewError && (
          <Banner tone="critical" onDismiss={() => setViewError(null)}>
            {viewError}
          </Banner>
        )}

        <Card padding="0">
          <InlineGrid columns={{ xs: 1, sm: 3 }}>
            <Stat label="Bundles" value={String(summary.count)} />
            <Box borderInlineStartWidth="025" borderColor="border">
              <Stat label="In campaigns" value={String(summary.inCampaigns)} />
            </Box>
            <Box borderInlineStartWidth="025" borderColor="border">
              <Stat label="Avg. saving" value={formatMoney(summary.avgSaving)} />
            </Box>
          </InlineGrid>
        </Card>

        <Card padding="0">
          {isLoading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
              <Spinner accessibilityLabel="Loading bundles" size="small" />
            </div>
          ) : (
            <IndexTable
              resourceName={{ singular: 'bundle', plural: 'bundles' }}
              itemCount={bundles.length}
              selectable={false}
              headings={[
                { title: 'Bundle' },
                { title: 'Items' },
                { title: 'Operation' },
                { title: 'Price', alignment: 'end' },
                { title: 'Save', alignment: 'end' },
                { title: 'In campaigns', alignment: 'end' },
                { title: '' },
              ]}
            >
              {bundles.map((b: Bundle, index: number) => {
                const price = moneyAmount(b.price);
                const sum = moneyAmount(b.sumOfItems);
                const save = price != null && sum != null
                  ? formatMoney({ amount: String(sum - price), currencyCode: b.price!.currencyCode })
                  : null;
                const saveAmount = price != null && sum != null ? sum - price : null;
                return (
                  <IndexTable.Row id={b.id} key={b.id} position={index}>
                    <IndexTable.Cell>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <SymbolTile symbol="⇄" size={30} />
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {b.name}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {b.items.length}
                            {' '}
                            variants ·
                            {b.updated}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <ItemThumbs count={b.items.length} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={OP_TONE[b.operation]}>{getOp(b.operation).label}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" numeric alignment="end" fontWeight="semibold">
                        {formatMoney(b.price)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <div style={{ textAlign: 'right' }}>
                        {save != null && saveAmount != null && saveAmount > 0 ? (
                          <Badge tone="success">{`−${save}`}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">—</Text>
                        )}
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" numeric alignment="end" tone="subdued">
                        —
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <ButtonGroup>
                        <Button variant="plain" onClick={() => navigate(`/bundles/${b.id}/edit`)}>
                          Edit
                        </Button>
                        <Button
                          variant="plain"
                          disabled={!b.parentVariantId}
                          onClick={() => handleViewInShopify(b.id)}
                        >
                          View in Shopify
                        </Button>
                      </ButtonGroup>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
