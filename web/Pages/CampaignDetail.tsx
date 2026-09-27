import { Page, Text } from '@shopify/polaris';

/**
 * Placeholder for the campaign detail/publish screen (Task 10). Wired here
 * only so the `/campaigns/:id` route compiles; Task 10 replaces this body,
 * not the route wiring in `App.tsx`.
 */
export default function CampaignDetail() {
  return (
    <Page title="Campaign detail">
      <Text as="p" tone="subdued">Coming soon.</Text>
    </Page>
  );
}
