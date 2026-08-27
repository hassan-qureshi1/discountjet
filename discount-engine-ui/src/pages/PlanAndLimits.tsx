import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Divider,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  ProgressBar,
  Text,
} from '@shopify/polaris';
import { usePlan } from '../store/useDiscountStore';
import { SectionHeader } from '../components/common/SectionHeader';

export default function PlanAndLimits() {
  const plan = usePlan();

  return (
    <Page
      title="Plan & limits"
      subtitle="Placeholder tiers for M1. The enforcement mechanism ships and is testable, but limits are seeded high so it stays inert."
    >
      <BlockStack gap="400">
        <Banner tone="warning" title={plan.banner.title}>
          <p>{plan.banner.description}</p>
        </Banner>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="span" variant="headingXs" tone="subdued">
                CURRENT PLAN
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" variant="headingXl" fontWeight="bold">
                  {plan.current}
                </Text>
                <Badge tone="warning">Placeholder</Badge>
              </InlineStack>

              <BlockStack gap="150">
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Discounts used
                  </Text>
                  <Text as="span" variant="bodySm" numeric fontWeight="semibold">
                    {plan.used} / {plan.limit}
                  </Text>
                </InlineStack>
                <ProgressBar progress={plan.usagePercent} size="small" tone="success" />
              </BlockStack>

              <Text as="p" variant="bodySm" tone="subdued">
                Reconcile compares active count vs. allowed and deactivates the newest over-limit
                discount. With {plan.used} of {plan.limit}, it’s a no-op.
              </Text>
            </BlockStack>
          </Card>

          <Card padding="0">
            <Box padding="400" paddingBlockEnd="300">
              <SectionHeader
                title="Tiers"
                action={
                  <Text as="span" variant="bodySm" tone="subdued">
                    values TBD
                  </Text>
                }
              />
            </Box>
            <Divider />
            <IndexTable
              resourceName={{ singular: 'tier', plural: 'tiers' }}
              itemCount={plan.tiers.length}
              selectable={false}
              headings={[
                { title: 'Plan' },
                { title: 'Discount limit', alignment: 'end' },
                { title: '', alignment: 'end' },
              ]}
            >
              {plan.tiers.map((tier, index) => (
                <IndexTable.Row id={tier.name} key={tier.name} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {tier.name}
                      </Text>
                      {tier.current && <Badge tone="success">Current</Badge>}
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" numeric alignment="end">
                      {tier.limit}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm" tone="subdued" alignment="end">
                      placeholder
                    </Text>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
