import {
  BlockStack, Icon, InlineStack, Link, Text, Thumbnail,
} from '@shopify/polaris';
import { ExternalIcon, ImageIcon } from '@shopify/polaris-icons';
import type { ResolvedVariant } from '../bundles/api';

/** Shopify's name for a product's only variant; showing it adds nothing. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * Renders a variant the way a merchant recognises it: thumbnail, product name,
 * and the variant title when it says something.
 *
 * Two layouts, differing in who owns navigation. `stacked` is a row in a list
 * and carries no links of its own — the row's action cluster holds them (see
 * `VariantLinks`). `inline` goes inside a Polaris `Tag`, which has no action
 * area, so there the name links into the admin and a small icon opens the
 * storefront.
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

  // A product with no imagery still gets a thumbnail, now carrying Polaris's
  // image placeholder icon. This used to render nothing, on the reasoning that
  // an empty box was noisier than just the name — true when these were loose
  // labels, wrong now that they are rows in a list: a missing thumbnail pulls
  // its row's text left and out of line with every other row, which reads as a
  // layout bug rather than as "no photo yet".
  //
  // Alt text falls back to the product name, so the image is never announced
  // as an unlabelled graphic.
  const thumbnail = (
    <Thumbnail
      source={resolved.imageUrl ?? ImageIcon}
      alt={resolved.imageAlt ?? productTitle}
      size={layout === 'inline' ? 'extraSmall' : 'small'}
    />
  );

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

  // Stacked layout carries no links of its own: the surfaces that use it lay
  // each variant out as a row with an action cluster (admin, storefront,
  // remove), and that cluster owns navigation. Two ways to reach the same
  // admin page in one row reads as a mistake, not a convenience.
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      {thumbnail}
      <BlockStack gap="050">
        <Text as="span" variant="bodyMd" fontWeight="medium">{productTitle}</Text>
        {variantTitle && (
          <Text as="span" variant="bodySm" tone="subdued">{variantTitle}</Text>
        )}
      </BlockStack>
    </InlineStack>
  );
}
