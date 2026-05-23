import { useAppBridge } from '@shopify/app-bridge-react';
import { authenticatedFetch } from '@shopify/app-bridge/utilities';
import { useQuery } from '@tanstack/react-query';
import {
  Banner,
  Card,
  Layout,
  Page,
  Spinner,
  Text,
  VerticalStack,
} from '@shopify/polaris';
import { apiFetch } from '../api';

export default function Home() {
  const app = useAppBridge();
  const fetcher = authenticatedFetch(app);

  const { data, isLoading, error } = useQuery({
    queryKey: ['example'],
    queryFn: () => apiFetch(fetcher, '/api/example'),
  });

  return (
    <Page title="Cloudflare Shopify Starter">
      <Layout>
        <Layout.Section>
          <Card>
            <VerticalStack gap="4">
              <Text as="h2" variant="headingMd">Example protected API call</Text>
              {isLoading && <Spinner accessibilityLabel="Loading" size="small" />}
              {error && (
                <Banner tone="critical">
                  {error instanceof Error ? error.message : 'Failed to fetch /api/example'}
                </Banner>
              )}
              {data && (
                <Text as="p">
                  shopId:
                  {' '}
                  <code>{data.shopId}</code>
                  <br />
                  server time:
                  {' '}
                  <code>{data.now}</code>
                </Text>
              )}
            </VerticalStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
