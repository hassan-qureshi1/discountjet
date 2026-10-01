import { Button, InlineStack } from '@shopify/polaris';
import { ProductIcon, StoreIcon } from '@shopify/polaris-icons';
import type { ResolvedVariant } from '../bundles/api';

/**
 * The two places a merchant goes to look at a variant: its admin page (where
 * they edit it) and its live storefront page (what a shopper sees).
 *
 * Icon-only on purpose — these sit in a row that already names the product, so
 * a text label would repeat what is directly beside it. Each button still
 * carries an `accessibilityLabel` naming the product, so a screen reader
 * announces "View Blue T-Shirt in the admin" rather than an unlabelled button.
 *
 * Renders nothing for a variant that hasn't resolved or no longer exists in
 * Shopify — there is no page to open, and a dead control is worse than none.
 */
export function VariantLinks({
  resolved,
  fallback,
}: {
  resolved: ResolvedVariant | undefined;
  fallback: string;
}) {
  if (!resolved?.exists) return null;

  const name = resolved.productTitle ?? fallback;

  return (
    <InlineStack gap="100" blockAlign="center">
      {resolved.adminUrl && (
        <Button
          variant="tertiary"
          icon={ProductIcon}
          url={resolved.adminUrl}
          // Navigating the embedded app's iframe to an admin URL breaks out of
          // the app instead of opening the page.
          target="_blank"
          accessibilityLabel={`View ${name} in the Shopify admin`}
        />
      )}
      {/* Absent for a product that isn't published to the Online Store:
          Shopify reports no `onlineStoreUrl`, so there is no page to open. */}
      {resolved.storefrontUrl && (
        <Button
          variant="tertiary"
          icon={StoreIcon}
          url={resolved.storefrontUrl}
          target="_blank"
          accessibilityLabel={`View ${name} in the online store`}
        />
      )}
    </InlineStack>
  );
}
