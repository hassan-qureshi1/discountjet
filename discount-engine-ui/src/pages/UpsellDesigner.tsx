import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import { useDiscount } from '../store/useDiscountStore';
import { SegmentedControl } from '../components/common/SegmentedControl';

interface Elements {
  image: boolean;
  title: boolean;
  price: boolean;
  strike: boolean;
  save: boolean;
  atc: boolean;
}

const PRODUCTS = [
  { emoji: '🛌', name: 'Memory Foam Pillow', price: '$0.00', strike: '$79.00', save: 'Free' },
  { emoji: '▧', name: 'Bamboo Sheet Set', price: '$119.20', strike: '$149.00', save: '−20%' },
  { emoji: '▤', name: 'Mattress Protector', price: '$44.50', strike: '$89.00', save: '−50%' },
];

const SWATCHES = ['#008060', '#1a1a1a', '#b45309', '#4b6bfb'];

export default function UpsellDesigner() {
  const { id } = useParams();
  const discount = useDiscount(id);
  const navigate = useNavigate();

  const [heading, setHeading] = useState('Complete your bedroom');
  const [btnLabel, setBtnLabel] = useState('Add');
  const [productCount, setProductCount] = useState('3 products');
  const [layout, setLayout] = useState(0); // 0 list, 1 grid
  const [accent, setAccent] = useState('#008060');
  const [preview, setPreview] = useState(0); // 0 pdp, 1 cart
  const [elements, setElements] = useState<Elements>({
    image: true,
    title: true,
    price: true,
    strike: true,
    save: true,
    atc: true,
  });

  const toggle = (key: keyof Elements) => setElements((e) => ({ ...e, [key]: !e[key] }));
  const backTo = discount ? `/discounts/${discount.id}` : '/discounts';

  return (
    <Page
      backAction={{ content: discount?.name ?? 'Discount', onAction: () => navigate(backTo) }}
      title="Upsell card designer"
      subtitle={`Designing the upsell for ${discount?.name ?? 'this discount'}. Changes preview live on the right.`}
      primaryAction={{ content: 'Save & publish' }}
      secondaryActions={[{ content: 'Reset' }]}
    >
      <BlockStack gap="400">
        <Banner tone="info" title="One card, two placements">
          <p>
            This card shows on the product page and in the cart. Toggle each placement below, and switch the preview
            between PDP and Cart to see both. Products and prices come from this discount’s config.
          </p>
        </Banner>

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          {/* Settings */}
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Content
                </Text>
                <TextField label="Section heading" value={heading} onChange={setHeading} autoComplete="off" />
                <TextField label="Add-to-cart button label" value={btnLabel} onChange={setBtnLabel} autoComplete="off" />
                <Select
                  label="Products to show"
                  options={['2 products', '3 products', '4 products', '6 products']}
                  value={productCount}
                  onChange={setProductCount}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Elements
                </Text>
                <Checkbox label="Product image" checked={elements.image} onChange={() => toggle('image')} />
                <Checkbox label="Product title" checked={elements.title} onChange={() => toggle('title')} />
                <Checkbox label="Discounted price" checked={elements.price} onChange={() => toggle('price')} />
                <Checkbox label="Crossed-out original price" checked={elements.strike} onChange={() => toggle('strike')} />
                <Checkbox label="Savings badge" checked={elements.save} onChange={() => toggle('save')} />
                <Checkbox label="Add-to-cart button" checked={elements.atc} onChange={() => toggle('atc')} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Layout &amp; style
                </Text>
                <BlockStack gap="150">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Layout
                  </Text>
                  <SegmentedControl options={['List', 'Grid']} selected={layout} onChange={setLayout} />
                </BlockStack>
                <BlockStack gap="150">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Accent colour — ✨ auto-detected from your theme (Dawn)
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    {SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Accent ${color}`}
                        onClick={() => setAccent(color)}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          cursor: 'pointer',
                          background: color,
                          border: 'none',
                          boxShadow:
                            accent === color
                              ? '0 0 0 2px var(--p-color-bg-surface), 0 0 0 4px var(--p-color-border-brand)'
                              : 'inset 0 0 0 1px rgba(0,0,0,.12)',
                        }}
                      />
                    ))}
                    <Text as="span" variant="bodySm" tone="subdued">
                      {accent.toUpperCase()}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Placement
                </Text>
                <Checkbox label="Product page (PDP)" checked onChange={() => undefined} />
                <Checkbox label="Cart & drawer" checked onChange={() => undefined} />
                <Checkbox label="Sticky footer bar" checked={false} onChange={() => undefined} />
                <Select
                  label="Position on PDP"
                  options={['Below add-to-cart', 'Above description', 'After image gallery']}
                  value="Below add-to-cart"
                  onChange={() => undefined}
                />
              </BlockStack>
            </Card>
          </BlockStack>

          {/* Live preview */}
          <div style={{ position: 'sticky', top: 16 }}>
            <BlockStack gap="200">
              <Text as="span" variant="bodySm" tone="subdued" alignment="center">
                Live preview
              </Text>
              <div
                style={{
                  background: 'var(--p-color-bg-surface)',
                  borderRadius: 18,
                  overflow: 'hidden',
                  boxShadow: '0 4px 12px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.05)',
                  border: '1px solid var(--p-color-border)',
                }}
              >
                <div
                  style={{
                    background: 'var(--p-color-bg-surface-secondary)',
                    padding: '9px 16px',
                    fontSize: 12,
                    color: 'var(--p-color-text-secondary)',
                    borderBottom: '1px solid var(--p-color-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>🔒 eva-home.com</span>
                  <SegmentedControl options={['PDP', 'Cart']} selected={preview} onChange={setPreview} />
                </div>
                <div style={{ padding: 16 }}>
                  <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
                    <div
                      style={{
                        width: 84,
                        height: 84,
                        borderRadius: 12,
                        background: 'var(--p-color-bg-surface-tertiary)',
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: 30,
                        flex: '0 0 auto',
                      }}
                    >
                      🛏
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {preview === 0 ? 'Oak Bed Frame — Queen' : 'Your cart · 2 items'}
                      </div>
                      <div style={{ margin: '6px 0', fontWeight: 700 }}>$899.00</div>
                      <div style={{ fontSize: 12, color: 'var(--p-color-text-secondary)' }}>
                        Solid oak · 10-year warranty
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, fontWeight: 700, margin: '2px 0 10px', display: 'flex', gap: 8, alignItems: 'center' }}>
                    ✦ {heading || 'Recommended for you'} <Badge tone="info">Active discount</Badge>
                  </div>

                  <div
                    style={{
                      display: layout === 1 ? 'grid' : 'flex',
                      gridTemplateColumns: layout === 1 ? '1fr 1fr' : undefined,
                      flexDirection: layout === 1 ? undefined : 'column',
                      gap: 10,
                    }}
                  >
                    {PRODUCTS.map((p) => (
                      <div
                        key={p.name}
                        style={{
                          display: 'flex',
                          flexDirection: layout === 1 ? 'column' : 'row',
                          gap: 12,
                          alignItems: layout === 1 ? 'flex-start' : 'center',
                          padding: 10,
                          border: '1px solid var(--p-color-border)',
                          borderRadius: 12,
                        }}
                      >
                        {elements.image && (
                          <div
                            style={{
                              width: 50,
                              height: 50,
                              borderRadius: 8,
                              background: 'var(--p-color-bg-surface-tertiary)',
                              display: 'grid',
                              placeItems: 'center',
                              fontSize: 20,
                              flex: '0 0 auto',
                            }}
                          >
                            {p.emoji}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {elements.title && <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>}
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            {elements.price && <span style={{ fontSize: 14, fontWeight: 700 }}>{p.price}</span>}
                            {elements.strike && (
                              <span style={{ color: 'var(--p-color-text-secondary)', textDecoration: 'line-through', fontSize: 12.5 }}>
                                {p.strike}
                              </span>
                            )}
                            {elements.save && (
                              <span style={{ color: '#0c5132', background: '#cdfee1', fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 6 }}>
                                {p.save}
                              </span>
                            )}
                          </div>
                        </div>
                        {elements.atc && (
                          <button
                            type="button"
                            style={{
                              border: 'none',
                              background: accent,
                              color: '#fff',
                              fontWeight: 600,
                              fontSize: 12,
                              padding: '7px 12px',
                              borderRadius: 8,
                              cursor: 'pointer',
                              width: layout === 1 ? '100%' : 'auto',
                            }}
                          >
                            {btnLabel || 'Add'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </BlockStack>
          </div>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
