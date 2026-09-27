import { Page, Text } from '@shopify/polaris';

/**
 * Placeholder for the template-driven discount create flow (Task 10). Keeps
 * `/templates/:slug` routable now so the gallery's `onAction` navigation has
 * somewhere to land; the real form replaces this body in the next task.
 */
export default function TemplateCreate() {
  return (
    <Page title="Create discount" backAction={{ url: '/templates' }}>
      <Text as="p">Coming soon.</Text>
    </Page>
  );
}
