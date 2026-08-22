import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import { Stepper } from '../components/common/Stepper';
import { ChoiceCard } from '../components/common/ChoiceCard';
import { SegmentedControl } from '../components/common/SegmentedControl';
import { KeyValueList } from '../components/common/KeyValueList';

const STEPS = ['Offer type', 'Discount', 'Savings levels', 'Review'];

const TYPE_LABEL: Record<string, string> = {
  Tier: 'Tier discount',
  Bundle: 'Bundle discount',
  Split: 'Split bundle discount',
};
const TYPE_OFFER: Record<string, number> = { Tier: 0, Bundle: 1, Split: 2 };

export default function DiscountSetup() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const kind = params.get('type') ?? '';
  const discountLabel = TYPE_LABEL[kind] ?? 'Volume discount';

  const [method, setMethod] = useState(0);
  const [title, setTitle] = useState('Buy 2 Pillows, save 15%');
  const [step, setStep] = useState(0);
  const [offerType, setOfferType] = useState(TYPE_OFFER[kind] ?? 0);
  const [message, setMessage] = useState('Buy more, save more');

  return (
    <Page
      backAction={{ content: 'Discounts', onAction: () => navigate('/discounts') }}
      title="Create discount"
      subtitle={`Discount Engine · ${discountLabel}`}
      primaryAction={{ content: 'Save discount' }}
      secondaryActions={[{ content: 'Discard', onAction: () => navigate('/discounts') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="150">
                <Text as="span" variant="bodyMd">
                  Method
                </Text>
                <SegmentedControl
                  options={['Automatic discount', 'Discount code']}
                  selected={method}
                  onChange={setMethod}
                />
              </BlockStack>
              <TextField
                label="Title"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                helpText="Customers see this in their cart and at checkout."
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="span" variant="bodySm" tone="subdued">
                Function settings · discount-ui
              </Text>
              <Box
                background="bg-surface-secondary"
                padding="400"
                borderRadius="300"
                borderWidth="025"
                borderColor="border"
              >
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">
                    Set up your discount
                  </Text>
                  <Stepper steps={STEPS} current={step} onSelect={setStep} />
                  <Divider />

                  {step === 0 && (
                    <BlockStack gap="200">
                      <Text as="span" variant="bodyMd">
                        What kind of offer is this?
                      </Text>
                      <ChoiceCard
                        title="Volume discount — buy more, save more"
                        helpText="Shoppers unlock a bigger discount as they add more of the same products."
                        selected={offerType === 0}
                        onChange={() => setOfferType(0)}
                      />
                      <ChoiceCard
                        title="Buy X, get Y discounted"
                        helpText="Buy the qualifying products and the products you choose get discounted."
                        selected={offerType === 1}
                        onChange={() => setOfferType(1)}
                      />
                      <ChoiceCard
                        title="Buy X, discount both items"
                        helpText="Discount both the qualifying products and the products they unlock."
                        selected={offerType === 2}
                        onChange={() => setOfferType(2)}
                      />
                    </BlockStack>
                  )}

                  {step === 1 && (
                    <BlockStack gap="300">
                      <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                        <Select label="Discount type" options={['Percentage off', 'Fixed amount off']} onChange={() => undefined} value="Percentage off" />
                        <Select label="Discount from" options={['Selling price', 'Original (compare-at) price']} onChange={() => undefined} value="Selling price" />
                        <Select label="Where does this apply?" options={['Online store & in person (POS)', 'In person only (POS)', 'Online store only']} onChange={() => undefined} value="Online store & in person (POS)" />
                      </InlineGrid>
                      <TextField label="Message shown to shoppers at checkout" value={message} onChange={setMessage} autoComplete="off" />
                    </BlockStack>
                  )}

                  {step === 2 && (
                    <BlockStack gap="300">
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          Savings levels
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          Each level sets a discount and the products it applies to.
                        </Text>
                      </BlockStack>
                      <Box padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                        <BlockStack gap="300">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            Savings level 1
                          </Text>
                          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                            <TextField label="Discount percentage" value="15" onChange={() => undefined} autoComplete="off" suffix="%" />
                            <TextField label="Minimum quantity to unlock" value="2" onChange={() => undefined} autoComplete="off" />
                            <Select label="Match products by" options={['Specific variants', 'Whole products']} onChange={() => undefined} value="Specific variants" />
                          </InlineGrid>
                          <InlineStack>
                            <Button>Choose products</Button>
                          </InlineStack>
                          <InlineStack gap="150">
                            <Badge>Memory Foam Pillow (STD, KING)</Badge>
                          </InlineStack>
                        </BlockStack>
                      </Box>
                      <InlineStack>
                        <Button>Add another level</Button>
                      </InlineStack>
                    </BlockStack>
                  )}

                  {step === 3 && (
                    <BlockStack gap="300">
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          Here’s what shoppers will get
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          All levels: discount from the selling price · applies to every qualifying product · works
                          online store &amp; in person (POS) · shown as “Buy more, save more”.
                        </Text>
                      </BlockStack>
                      <Box padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                        <BlockStack gap="200">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              Savings level 1
                            </Text>
                            <Badge tone="info">15% off</Badge>
                          </InlineStack>
                          <Text as="span" variant="bodySm">
                            Buy 2+ of these products to get 15% off.
                          </Text>
                          <Divider />
                          <KeyValueList
                            items={[
                              { term: 'Discount', description: '15% off · from the selling price' },
                              { term: 'Minimum quantity', description: '2' },
                              { term: 'If several qualify', description: 'Discount every qualifying product' },
                            ]}
                          />
                        </BlockStack>
                      </Box>
                      <Banner tone="success">
                        <p>
                          All set. Press <b>Save discount</b> at the top of the page to publish. Use Back to edit any
                          step.
                        </p>
                      </Banner>
                    </BlockStack>
                  )}

                  <Divider />
                  <InlineStack gap="200">
                    <Button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
                      ← Back
                    </Button>
                    {step < STEPS.length - 1 && (
                      <Button variant="primary" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
                        Next →
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>
            </BlockStack>
          </Card>
        </BlockStack>

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Summary
              </Text>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {title}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                Discount Engine · {discountLabel}
              </Text>
              <Divider />
              <BlockStack gap="100">
                <Text as="span" variant="bodySm">• {method === 0 ? 'Automatic' : 'Code'} discount</Text>
                <Text as="span" variant="bodySm">• 15% off · 1 savings level</Text>
                <Text as="span" variant="bodySm">• Applies at POS &amp; Checkout</Text>
                <Text as="span" variant="bodySm">• Can’t combine with other discounts</Text>
              </BlockStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Active dates
              </Text>
              <InlineGrid columns={2} gap="300">
                <TextField label="Start date" value="2026-08-14" onChange={() => undefined} autoComplete="off" />
                <TextField label="Start time (AEST)" value="09:00" onChange={() => undefined} autoComplete="off" />
              </InlineGrid>
              <ButtonGroup>
                <Button>Set end date</Button>
              </ButtonGroup>
            </BlockStack>
          </Card>
        </BlockStack>
      </InlineGrid>
    </Page>
  );
}
