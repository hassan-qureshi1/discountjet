import { Page, Text } from '@shopify/polaris';

/**
 * Placeholder for the campaign create/edit wizard (Task 9). Wired here only
 * so the `/campaigns/:id/edit` route compiles; Task 9 replaces this body,
 * not the route wiring in `App.tsx`.
 */
export default function CampaignBuilder() {
  return (
    <Page title="Campaign builder">
      <Text as="p" tone="subdued">Coming soon.</Text>
    </Page>
  );
}
