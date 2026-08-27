import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Box,
  Card,
  Checkbox,
  InlineGrid,
  Page,
  Text,
  TextField,
} from '@shopify/polaris';
import { useAddDiscount, useTemplate } from '../store/useDiscountStore';
import type { DiscountType } from '../types';
import { SegmentedControl } from '../components/common/SegmentedControl';
import { ProductPicker } from '../components/discount/ProductPicker';
import { parseItems } from '../components/discount/discountForm';

// Template category → engine discount type + symbol.
const CATEGORY_TYPE: Record<string, DiscountType> = {
  'Save %': 'Tier',
  Volume: 'Tier',
  Clearance: 'Tier',
  Bundle: 'Bundle',
  BOGO: 'Special',
};
const SYMBOL: Record<DiscountType, string> = { Tier: '%', Bundle: '◱', Special: '◨' };

export default function CreatePromotion() {
  const { id } = useParams();
  const template = useTemplate(id);
  const addDiscount = useAddDiscount();
  const navigate = useNavigate();

  const [title, setTitle] = useState(template?.name ?? 'New promotion');
  const [label, setLabel] = useState('15% OFF');
  const [amount, setAmount] = useState('15');
  const [minQty, setMinQty] = useState('2');
  const [products, setProducts] = useState('[]');
  const [method, setMethod] = useState(0);
  const [code, setCode] = useState('SAVE15');
  const [startDate, setStartDate] = useState('2026-08-24');
  const [startTime, setStartTime] = useState('09:00');
  const [hasEnd, setHasEnd] = useState(true);
  const [endDate, setEndDate] = useState('2026-09-30');
  const [combineProduct, setCombineProduct] = useState(true);
  const [combineOrder, setCombineOrder] = useState(false);
  const [combineShipping, setCombineShipping] = useState(true);

  const productCount = parseItems(products).length;
  const type = CATEGORY_TYPE[template?.category ?? ''] ?? 'Tier';

  const save = () => {
    addDiscount({
      id: `d-${Date.now()}`,
      name: title.trim() || 'New promotion',
      symbol: SYMBOL[type],
      type,
      status: 'Active',
      products: productCount,
      updated: 'just now',
    });
    navigate('/discounts');
  };

  const combos = [
    combineProduct && 'Product',
    combineOrder && 'Order',
    combineShipping && 'Shipping',
  ].filter(Boolean);

  return (
    <Page
      backAction={{ content: 'Templates', onAction: () => navigate('/templates') }}
      title={template?.name ?? 'New promotion'}
      titleMetadata={<Badge tone="magic">Volume discount</Badge>}
      subtitle="Fill in a few details — pick the products yourself, choose how it runs, and it’s saved to Discounts."
      primaryAction={{ content: 'Save & activate', onAction: save }}
      secondaryActions={[{ content: 'Cancel', onAction: () => navigate('/templates') }]}
    >
      <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                The deal
              </Text>
              <TextField label="Discount title" value={title} onChange={setTitle} autoComplete="off" helpText="Internal name — shown in your Discounts list." />
              <TextField label="Label shoppers see" value={label} onChange={setLabel} autoComplete="off" helpText="Short label at checkout — e.g. “15% OFF”." />
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField label="Discount amount" type="number" value={amount} onChange={setAmount} suffix="%" autoComplete="off" min={0} />
                <TextField label="Minimum to qualify" type="number" value={minQty} onChange={setMinQty} suffix="items" autoComplete="off" min={0} />
              </InlineGrid>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Products
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                Pick the items this promotion applies to — nothing is selected for you.
              </Text>
              <ProductPicker label="Choose products" selectorType="variant_id" json={products} onChange={setProducts} />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Method &amp; schedule
              </Text>
              <BlockStack gap="150">
                <Text as="span" variant="bodyMd">
                  Method
                </Text>
                <SegmentedControl options={['Automatic discount', 'Discount code']} selected={method} onChange={setMethod} />
              </BlockStack>
              {method === 1 && (
                <TextField label="Discount code" value={code} onChange={setCode} autoComplete="off" helpText="Shoppers enter this at checkout." />
              )}
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField label="Start date" value={startDate} onChange={setStartDate} autoComplete="off" />
                <TextField label="Start time (AEST)" value={startTime} onChange={setStartTime} autoComplete="off" />
              </InlineGrid>
              <Checkbox label="Set an end date" checked={hasEnd} onChange={setHasEnd} />
              {hasEnd && (
                <TextField label="End date" value={endDate} onChange={setEndDate} autoComplete="off" />
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Combinations
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                This discount can be combined with:
              </Text>
              <Checkbox label="Product discounts" checked={combineProduct} onChange={setCombineProduct} />
              <Checkbox label="Order discounts" checked={combineOrder} onChange={setCombineOrder} />
              <Checkbox label="Shipping discounts" checked={combineShipping} onChange={setCombineShipping} />
            </BlockStack>
          </Card>
        </BlockStack>

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Summary
              </Text>
              <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                <BlockStack gap="050">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {label || `${amount}% OFF`}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {productCount > 0 ? `${productCount} product${productCount === 1 ? '' : 's'}` : 'No products chosen yet'}
                  </Text>
                </BlockStack>
              </Box>
              <Text as="span" variant="bodySm" tone="subdued">
                {method === 0 ? 'Automatic' : `Code “${code}”`} · runs {startDate}
                {hasEnd ? ` → ${endDate}` : ' onward'} · combines with {combos.length ? combos.join(', ') : 'nothing'}.
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                Saved to Discounts on activate — appears at the top of the list.
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      </InlineGrid>
    </Page>
  );
}
