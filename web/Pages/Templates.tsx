import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Banner, BlockStack, ButtonGroup, Button, InlineGrid, Page, Spinner,
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

  return (
    <Page
      title="Promotion templates"
      subtitle="No discount jargon required."
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical">{error.message}</Banner>}

        {isLoading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
            <Spinner accessibilityLabel="Loading templates" size="small" />
          </div>
        ) : (
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
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
