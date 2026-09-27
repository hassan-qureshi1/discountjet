import {
  BlockStack, InlineStack, Link, Text, Thumbnail,
} from '@shopify/polaris';
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
    return (
      <InlineStack gap="100" blockAlign="center">
        {thumbnail}
        {link}
        {variantTitle && (
          <Text as="span" variant="bodySm" tone="subdued">{variantTitle}</Text>
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
      </BlockStack>
    </InlineStack>
  );
}
