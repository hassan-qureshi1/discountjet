import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Banner, BlockStack, ButtonGroup, Button, EmptyState, InlineGrid, Page, Spinner, Text,
} from '@shopify/polaris';
import { useTemplates } from '../templates/hooks';
import { TemplateCard } from '../components/TemplateCard';

export default function Templates() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useTemplates();
  const [category, setCategory] = useState('All');

  const templates = data?.templates ?? [];
  const categories = useMemo(
    () => ['All', ...new Set(templates.map((t) => t.category))],
    [templates],
  );
  const visible = category === 'All' ? templates : templates.filter((t) => t.category === category);

  let body: ReactNode;
  if (error) {
    body = <Banner tone="critical">{error.message}</Banner>;
  } else if (isLoading) {
    body = (
      <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
        <Spinner accessibilityLabel="Loading templates" size="small" />
      </div>
    );
  } else if (templates.length === 0) {
    body = (
      <EmptyState heading="No templates yet" image="">
        <p>
          Templates are added when the app installs — reinstalling the app will add them.
        </p>
      </EmptyState>
    );
  } else {
    body = (
      <BlockStack gap="400">
        <ButtonGroup>
          {categories.map((c) => (
            <Button
              key={c}
              pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c}
            </Button>
          ))}
        </ButtonGroup>

        {visible.length === 0 ? (
          <Text as="p" tone="subdued">No templates in this category.</Text>
        ) : (
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
            {visible.map((t) => (
              <TemplateCard
                key={t.slug}
                symbol={t.symbol}
                name={t.name}
                description={t.description}
                example={t.example}
                category={t.category}
                onAction={() => navigate(`/templates/${encodeURIComponent(t.slug)}`)}
              />
            ))}
          </InlineGrid>
        )}
      </BlockStack>
    );
  }

  return (
    <Page
      title="Promotion templates"
      subtitle="No discount jargon required."
    >
      <BlockStack gap="400">
        {body}
      </BlockStack>
    </Page>
  );
}
