import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
} from '@shopify/polaris';
import { useTemplate } from '../store/useDiscountStore';
import { SegmentedControl } from '../components/common/SegmentedControl';

export default function CreatePromotion() {
  const { id } = useParams();
  const template = useTemplate(id);
  const navigate = useNavigate();

  const [label, setLabel] = useState('20% OFF');
  const [amount, setAmount] = useState('20');
  const [minQty, setMinQty] = useState('3');
  const [applyTo, setApplyTo] = useState(0);
  const [discountFrom, setDiscountFrom] = useState(0);
  const [channel, setChannel] = useState(0);

  return (
    <Page
      backAction={{ content: 'Templates', onAction: () => navigate('/templates') }}
      title={template?.name ?? 'New promotion'}
      titleMetadata={<Badge tone="magic">{template?.category ?? 'Promotion'}</Badge>}
      subtitle="Fill in a few details — we handle the discount engine underneath."
      primaryAction={{ content: 'Save & activate' }}
      secondaryActions={[{ content: 'Cancel', onAction: () => navigate('/templates') }]}
    >
      <BlockStack gap="400">
        <Box background="bg-surface-brand" padding="400" borderRadius="300">
          <Text as="p" variant="bodyLg">
            {template ? (
              <>
                <b>{template.name}</b> — for example, “{template.example}”. Set the details below and we build the
                discount function for you.
              </>
            ) : (
              'Start a promotion from scratch.'
            )}
          </Text>
        </Box>

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  The deal
                </Text>
                <TextField
                  label="Label shoppers see"
                  value={label}
                  onChange={setLabel}
                  autoComplete="off"
                  helpText="The short label at checkout. Keep it punchy — e.g. “20% OFF”."
                />
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <TextField label="Discount amount" value={amount} onChange={setAmount} autoComplete="off" suffix="%" helpText="How much off the qualifying items." />
                  <TextField label="Minimum to qualify" value={minQty} onChange={setMinQty} autoComplete="off" suffix="items" helpText="How many they must buy first." />
                </InlineGrid>
                <BlockStack gap="150">
                  <Text as="span" variant="bodyMd">
                    Choose products
                  </Text>
                  <InlineStack gap="150">
                    <Badge>Memory Foam Pillow — Standard</Badge>
                    <Badge>Memory Foam Pillow — King</Badge>
                  </InlineStack>
                  <InlineStack>
                    <Button variant="plain">Edit selection</Button>
                  </InlineStack>
                </BlockStack>
                <BlockStack gap="150">
                  <Text as="span" variant="bodyMd">
                    Which items get the deal?
                  </Text>
                  <SegmentedControl
                    options={['Every eligible item', 'Just one', 'Best-value item']}
                    selected={applyTo}
                    onChange={setApplyTo}
                  />
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Where &amp; how
                </Text>
                <BlockStack gap="150">
                  <Text as="span" variant="bodyMd">
                    Discount from
                  </Text>
                  <SegmentedControl options={['Current price', 'Original (RRP) price']} selected={discountFrom} onChange={setDiscountFrom} />
                  <Text as="span" variant="bodySm" tone="subdued">
                    Discount from the current price, or the RRP so the saving looks bigger.
                  </Text>
                </BlockStack>
                <BlockStack gap="150">
                  <Text as="span" variant="bodyMd">
                    Where it runs
                  </Text>
                  <SegmentedControl options={['Online', 'In-store', 'Both']} selected={channel} onChange={setChannel} />
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Shopper preview
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                How it looks in the cart
              </Text>
              <Box background="bg-surface-secondary" padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">{label || `${amount}% OFF`}</Badge>
                  <Text as="span" variant="bodySm">
                    applied when buying {minQty || 'the'} qualifying items
                  </Text>
                </InlineStack>
              </Box>
              <Text as="span" variant="bodySm" tone="subdued">
                Same strike-price math as the storefront — this is exactly what shoppers see.
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
