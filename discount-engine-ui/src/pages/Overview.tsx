import { useNavigate } from 'react-router-dom';
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { useOverview, useShop } from '../store/useDiscountStore';
import { StatCard } from '../components/common/StatCard';
import { SectionHeader } from '../components/common/SectionHeader';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolTile } from '../components/common/SymbolTile';

export default function Overview() {
  const overview = useOverview();
  const shop = useShop();
  const navigate = useNavigate();

  return (
    <Page
      title="Overview"
      subtitle={`Everything the app tracks for ${shop.name} — synced from Shopify discount webhooks into D1.`}
    >
      <BlockStack gap="400">
        <Banner tone="info" title={overview.banner.title}>
          <p>{overview.banner.description}</p>
        </Banner>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          {overview.stats.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card padding="0">
            <Box padding="400" paddingBlockEnd="300">
              <SectionHeader
                title="Recent discount activity"
                action={
                  <Button size="slim" onClick={() => navigate('/discounts')}>
                    View all
                  </Button>
                }
              />
            </Box>
            <Divider />
            <BlockStack>
              {overview.recentActivity.map((item, i) => (
                <Box
                  key={i}
                  padding="300"
                  borderBlockEndWidth={i < overview.recentActivity.length - 1 ? '025' : '0'}
                  borderColor="border-secondary"
                >
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <SymbolTile symbol={item.symbol} size={28} />
                    <Box width="100%">
                      <Text as="span" variant="bodyMd">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {item.title}
                        </Text>{' '}
                        {item.action}{' '}
                        <Text as="span" tone="subdued">
                          · {item.meta}
                        </Text>
                      </Text>
                    </Box>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {item.time}
                    </Text>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>

          <Card padding="0">
            <Box padding="400" paddingBlockEnd="300">
              <SectionHeader
                title="Cart-transform schedule"
                action={
                  <Button size="slim" onClick={() => navigate('/cart-transforms')}>
                    Manage
                  </Button>
                }
              />
            </Box>
            <Divider />
            <BlockStack>
              {overview.cartSchedule.map((item, i) => (
                <Box
                  key={i}
                  padding="300"
                  borderBlockEndWidth={i < overview.cartSchedule.length - 1 ? '025' : '0'}
                  borderColor="border-secondary"
                >
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <SymbolTile symbol={item.symbol} size={28} />
                    <Box width="100%">
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {item.title}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {item.detail}
                        </Text>
                      </BlockStack>
                    </Box>
                    <StatusBadge tone={item.tone} label={item.status} />
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
