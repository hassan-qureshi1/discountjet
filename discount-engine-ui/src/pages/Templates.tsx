import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BlockStack, Button, InlineGrid, InlineStack, Page, Text } from '@shopify/polaris';
import { useTemplates } from '../store/useDiscountStore';
import { TemplateCard } from '../components/common/TemplateCard';

const FILTERS = ['All', 'Save %', 'Bundle', 'BOGO', 'Volume', 'Clearance'] as const;

export default function Templates() {
  const templates = useTemplates();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');

  const visible = useMemo(
    () => (filter === 'All' ? templates : templates.filter((t) => t.category === filter)),
    [templates, filter],
  );

  return (
    <Page
      title="Promotion templates"
      subtitle="Pick a ready-made promotion, preview it, then tweak a couple of fields. No discount jargon required."
      secondaryActions={[{ content: 'Start from scratch', onAction: () => navigate('/discounts/new') }]}
    >
      <BlockStack gap="400">
        <InlineStack gap="200" wrap>
          {FILTERS.map((f) => (
            <Button
              key={f}
              pressed={filter === f}
              variant={filter === f ? 'primary' : 'secondary'}
              onClick={() => setFilter(f)}
            >
              {f}
            </Button>
          ))}
        </InlineStack>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
          {visible.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onUse={() => navigate(`/templates/${template.id}/create`)}
            />
          ))}
        </InlineGrid>

        <Text as="p" variant="bodySm" tone="subdued">
          Each template already carries its discount type underneath — you never pick a mechanism by
          name.
        </Text>
      </BlockStack>
    </Page>
  );
}
