import { useNavigate } from 'react-router-dom';
import { BlockStack, InlineGrid, Page, Text } from '@shopify/polaris';
import { useCampaignTemplates } from '../store/useDiscountStore';
import { TemplateCard } from '../components/common/TemplateCard';

export default function CampaignTemplates() {
  const templates = useCampaignTemplates();
  const navigate = useNavigate();

  return (
    <Page
      backAction={{ content: 'Campaigns', onAction: () => navigate('/campaigns') }}
      title="Campaign templates"
      subtitle="Start from a ready-made campaign — discounts, bundles and a schedule already wired up. Tweak a few fields and publish."
      secondaryActions={[{ content: 'Start from scratch', onAction: () => navigate('/campaigns/new') }]}
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} onUse={() => navigate('/campaigns/new')} />
          ))}
        </InlineGrid>
        <Text as="p" variant="bodySm" tone="subdued">
          Templates prefill the builder — you can add, remove or edit every discount and bundle before publishing.
        </Text>
      </BlockStack>
    </Page>
  );
}
