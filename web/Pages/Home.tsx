import { useAppBridge } from '@shopify/app-bridge-react';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  Banner,
  BlockStack,
  Card,
  DescriptionList,
  InlineStack,
  Layout,
  Link,
  Page,
  Spinner,
  Text,
} from '@shopify/polaris';
import { apiFetch, createAuthenticatedFetch } from '../api';

const REPO_URL = 'https://github.com/devkindhq/shopify-on-cloudflare';
const DEVKIND_URL = 'https://devkind.com.au';

type ShopProfile = {
  name: string | null;
  domain: string | null;
  myshopifyDomain: string | null;
  plan: string | null;
  owner: string | null;
  email: string | null;
  country: string | null;
  currency: string | null;
  installedAt: string | null;
  status: 'installed' | 'uninstalled' | null;
};

type ExampleResponse = { shop: ShopProfile };

const show = (v: string | null | undefined) => (v && v.trim() ? v : 'Not set');

const asDate = (iso: string | null) => {
  if (!iso) return 'Not set';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

const initials = (name: string) => name.replace(/^https?:\/\//, '').slice(0, 2).toUpperCase();

export default function Home() {
  const shopify = useAppBridge();
  const fetcher = createAuthenticatedFetch(shopify);

  const { data, isLoading, error } = useQuery<ExampleResponse, Error>({
    queryKey: ['shop'],
    queryFn: () => apiFetch<ExampleResponse>(fetcher, '/api/example'),
  });

  const shop = data?.shop;
  const storeName = show(shop?.name ?? shop?.myshopifyDomain);

  return (
    <Page title="Shopify on Cloudflare">
      <Layout>
        <Layout.Section>
          <Card>
            {isLoading && (
              <InlineStack align="center">
                <Spinner accessibilityLabel="Loading store" size="small" />
              </InlineStack>
            )}

            {error && (
              <Banner tone="critical">
                {error instanceof Error ? error.message : 'Could not load your store'}
              </Banner>
            )}

            {shop && (
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap={false}>
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <Avatar name={storeName} initials={initials(storeName)} />
                    <BlockStack gap="0">
                      <Text as="h2" variant="headingMd">
                        {storeName}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {show(shop.myshopifyDomain)}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <Badge tone={shop.status === 'installed' ? 'success' : 'attention'}>
                    {shop.status === 'installed' ? 'Installed' : 'Uninstalled'}
                  </Badge>
                </InlineStack>

                <DescriptionList
                  items={[
                    { term: 'Plan', description: show(shop.plan) },
                    { term: 'Owner', description: show(shop.owner) },
                    { term: 'Email', description: show(shop.email) },
                    { term: 'Country', description: show(shop.country) },
                    { term: 'Currency', description: show(shop.currency) },
                    { term: 'Primary domain', description: show(shop.domain) },
                    { term: 'Installed', description: asDate(shop.installedAt) },
                  ]}
                />
              </BlockStack>
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Built by Devkind
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                An open-source Shopify embedded-app starter for Cloudflare Workers.
              </Text>
              <InlineStack gap="500">
                <Link url={DEVKIND_URL} target="_blank">
                  devkind.com.au
                </Link>
                <Link url={REPO_URL} target="_blank">
                  View source on GitHub
                </Link>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
