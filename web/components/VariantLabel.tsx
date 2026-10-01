import {
  BlockStack, Icon, InlineStack, Link, Text, Thumbnail,
} from '@shopify/polaris';
import { ExternalIcon } from '@shopify/polaris-icons';
import type { ResolvedVariant } from '../bundles/api';

/** Shopify's name for a product's only variant; showing it adds nothing. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * Renders a variant the way a merchant recognises it: thumbnail, product name
 * linked into the admin, and the variant title when it says something.
 *
 * Handles the three states any variant lookup has — not resolved yet, resolved
 * but deleted in Shopify, and live — so no caller has to reinvent them.
 */
export function VariantLabel({
  resolved,
  fallback,
  layout = 'stacked',
}: {
  resolved: ResolvedVariant | undefined;
  fallback: string;
  layout?: 'stacked' | 'inline';
}) {
  if (!resolved) {
    return <Text as="span" variant="bodyMd">{fallback}</Text>;
  }

  if (!resolved.exists) {
    return (
      <Text as="span" variant="bodyMd" tone="critical">
        {`${fallback} · no longer exists in Shopify`}
      </Text>
    );
  }

  const productTitle = resolved.productTitle ?? fallback;
  const variantTitle = resolved.variantTitle && resolved.variantTitle !== DEFAULT_VARIANT_TITLE
    ? resolved.variantTitle
    : undefined;

  // No placeholder when a product has no imagery — an empty Thumbnail box is
  // noisier than just the name. Alt text falls back to the product name so the
  // image is never announced as an unlabelled graphic.
  const thumbnail = resolved.imageUrl ? (
    <Thumbnail
      source={resolved.imageUrl}
      alt={resolved.imageAlt ?? productTitle}
      size={layout === 'inline' ? 'extraSmall' : 'small'}
    />
  ) : null;

  // `target="_blank"` matters inside the embedded admin: navigating the app
  // iframe to an admin URL breaks out of the app rather than opening the page.
  const link = (
    <Link url={resolved.adminUrl} target="_blank" removeUnderline>
      {productTitle}
    </Link>
  );

  if (layout === 'inline') {
    // Inside a Polaris `Tag` there is no room for a second labelled link, so
    // the storefront gets an icon-only control. The product title keeps its
    // admin link, which is where a merchant goes to EDIT; the icon is the
    // shopper's-eye view.
    return (
      <InlineStack gap="100" blockAlign="center">
        {thumbnail}
        {link}
        {variantTitle && (
          <Text as="span" variant="bodySm" tone="subdued">{variantTitle}</Text>
        )}
        {resolved.storefrontUrl && (
          <Link
            url={resolved.storefrontUrl}
            target="_blank"
            accessibilityLabel={`View ${productTitle} in the online store`}
            removeUnderline
          >
            <Icon source={ExternalIcon} tone="subdued" />
          </Link>
        )}
      </InlineStack>
    );
  }

  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      {thumbnail}
      <BlockStack gap="050">
        {link}
        {variantTitle && (
          <Text as="span" variant="bodySm" tone="subdued">{variantTitle}</Text>
        )}
        {/* The storefront link is omitted entirely for an unpublished product:
            Shopify reports no `onlineStoreUrl` for one, and a link that 404s is
            worse than no link. */}
        <InlineStack gap="150" blockAlign="center">
          <Link url={resolved.adminUrl} target="_blank">
            <Text as="span" variant="bodySm">Admin</Text>
          </Link>
          {resolved.storefrontUrl && (
            <Link url={resolved.storefrontUrl} target="_blank">
              <Text as="span" variant="bodySm">Storefront</Text>
            </Link>
          )}
        </InlineStack>
      </BlockStack>
    </InlineStack>
  );
}
