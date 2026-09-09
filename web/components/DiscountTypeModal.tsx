import { Badge, BlockStack, InlineStack, Modal, Text } from '@shopify/polaris';
import type { DiscountEngineKind } from '../types/discounts';

interface TypeRowProps {
  symbol: string;
  title: string;
  description: string;
  onClick?: () => void;
  brand?: boolean;
}

function TypeRow({ symbol, title, description, onClick, brand }: TypeRowProps) {
  const interactive = Boolean(onClick);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        textAlign: 'left',
        padding: '11px 12px',
        borderRadius: 10,
        border: '1px solid transparent',
        background: 'none',
        fontFamily: 'inherit',
        cursor: interactive ? 'pointer' : 'default',
        opacity: interactive ? 1 : 0.6,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 36,
          height: 36,
          borderRadius: 9,
          display: 'grid',
          placeItems: 'center',
          fontSize: 16,
          flex: '0 0 auto',
          background: brand ? 'var(--p-color-bg-surface-brand)' : 'var(--p-color-bg-surface-tertiary)',
          color: brand ? 'var(--p-color-text-brand)' : 'inherit',
          boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
        }}
      >
        {symbol}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, fontSize: 13.5, color: 'var(--p-color-text)' }}>
          {title}
        </span>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--p-color-text-secondary)' }}>
          {description}
        </span>
      </span>
      {interactive && <span style={{ color: 'var(--p-color-text-secondary)', fontSize: 18 }}>›</span>}
    </button>
  );
}

const NATIVE = [
  { symbol: '🏷️', title: 'Amount off products', description: 'Discount specific products or collections' },
  { symbol: '🎁', title: 'Buy X get Y', description: 'Discount products based on a customer’s purchase' },
  { symbol: '🧾', title: 'Amount off order', description: 'Discount the total order amount' },
  { symbol: '🚚', title: 'Free shipping', description: 'Offer free shipping on an order' },
];

const ENGINE: { kind: DiscountEngineKind; symbol: string; title: string; description: string }[] = [
  { kind: 'Tier', symbol: '%', title: 'Volume discount', description: 'Buy more, save more — a bigger discount as shoppers add more of the same products.' },
  { kind: 'Bundle', symbol: '◱', title: 'Buy X, get Y', description: 'Buying the qualifying products discounts the products you choose.' },
  { kind: 'Split', symbol: '◨', title: 'Buy X, discount both', description: 'Discount both the qualifying products and the ones they unlock.' },
];

export function DiscountTypeModal({
  open,
  onClose,
  onSelectEngine,
}: {
  open: boolean;
  onClose: () => void;
  onSelectEngine: (kind: DiscountEngineKind) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Select discount type">
      <Modal.Section>
        <BlockStack gap="200">
          <Text as="span" variant="headingXs" tone="subdued">
            SHOPIFY
          </Text>
          <BlockStack gap="050">
            {NATIVE.map((t) => (
              <TypeRow key={t.title} symbol={t.symbol} title={t.title} description={t.description} />
            ))}
          </BlockStack>

          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="headingXs">
              Discount Engine
            </Text>
            <Badge tone="magic">App</Badge>
          </InlineStack>
          <BlockStack gap="050">
            {ENGINE.map((t) => (
              <TypeRow
                key={t.kind}
                brand
                symbol={t.symbol}
                title={t.title}
                description={t.description}
                onClick={() => onSelectEngine(t.kind)}
              />
            ))}
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
