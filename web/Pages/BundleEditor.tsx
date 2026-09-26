// web/Pages/BundleEditor.tsx
//
// Create/edit screen for a bundle. Ported from
// discount-engine-ui/src/pages/CartTransformEditor.tsx with two corrections:
//   1. No app-tier concept — only the `update` operation is gated, and only
//      by Shopify Plus eligibility (web/bundles/ops.ts gateOperation).
//   2. Variant selection uses the real App Bridge ResourcePicker instead of
//      the prototype's hardcoded CATALOGUE.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppBridge } from '@shopify/app-bridge-react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Link,
  List,
  Modal,
  Page,
  Spinner,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from '@shopify/polaris';
import {
  useBundleQuery, useCreateBundle, useDeleteBundle, useShopPlanQuery, useUpdateBundle,
  useVariantsQuery,
} from '../bundles/hooks';
import type { BundleInput, BundleItemInput, ResolvedVariant } from '../bundles/api';
import { flattenPickerSelection, selectionIdsFromVariants } from '../bundles/picker';
import { OperationPicker } from '../components/OperationPicker';
import {
  CART_TRANSFORM_LIMITS,
  gateOperation,
  getOp,
  MAX_EXPAND_QTY,
} from '../bundles/ops';
import type { BundleOperation, BundleStatus } from '../types/bundles';
import { formatMoney, moneyAmount, currencySymbol } from '../lib/money';
import { sumItemPrices } from '../bundles/preview';

/** What the editor holds while the merchant is picking. NOT the wire shape:
 *  `price` is a plain number for the live preview only — the server re-resolves
 *  every price from Shopify on save and ignores whatever we send. */
interface DraftItem {
  variantId: string;
  name: string;
  qty: number;
  price: number | null;
  priceAdjustment?: number;
  titleOverride?: string;
}

const OP_TONE: Record<BundleOperation, 'info' | 'magic' | 'warning'> = {
  merge: 'info',
  expand: 'magic',
  update: 'warning',
};

/** `gid://shopify/ProductVariant/123` → `Variant #123`, used when a picked
 * variant's title hasn't been captured yet (e.g. items loaded from an
 * existing bundle, before the merchant re-opens the picker). */
const shortVariantLabel = (variantId: string) => {
  const match = variantId.match(/(\d+)$/);
  return match ? `Variant #${match[1]}` : variantId;
};

/** Shopify's placeholder title for a product with no variant options — never
 * worth showing next to the product name. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * Renders a picked variant as its real product name (linked into the Shopify
 * admin) with the variant title beneath. Names are resolved fresh on page load
 * via `useVariantsQuery` and never stored app-side, so a rename in Shopify
 * shows up on the next load.
 *
 * Degrades in two steps rather than blanking: an unresolved variant (still
 * loading, or the lookup failed) falls back to the `Variant #123` label, and
 * one Shopify no longer knows about is called out as deleted — a silently
 * missing component is how a bundle quietly stops expanding at checkout.
 *
 * `layout="inline"` is the single-line form used inside a Polaris `Tag`,
 * which can't hold a stacked block — it carries an extra-small thumbnail,
 * where the stacked form gets a small one.
 */
function VariantLabel({
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

/** Feature-detects the App Bridge ResourcePicker without crashing in local
 * dev, where the app isn't embedded and `window.shopify` may be a throwing
 * proxy or may not expose `resourcePicker` at all. */
function isResourcePickerAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return typeof window.shopify?.resourcePicker === 'function';
  } catch {
    return false;
  }
}

export default function BundleEditor() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const { data, isLoading, error } = useBundleQuery(id);
  const bundle = data?.bundle;
  const isNotFound = error ? /failed: 404\b/.test(error.message) : false;

  // CORRECTED gating: no app-tier concept, only `update` is Plus-gated.
  // Defaults to false while the plan is loading (fail closed).
  const { data: planData } = useShopPlanQuery();
  const updateOpEligible = planData?.updateOpEligible ?? false;

  const pickerAvailable = isResourcePickerAvailable();

  const [name, setName] = useState('New bundle');
  // A create arrives from the list page's operation chooser, which puts the
  // choice in the URL. Reading it here (rather than from router state) is what
  // makes the link survive a refresh or a share. An unrecognised or absent
  // value falls back to `merge` rather than failing — the in-editor selector
  // can still change it, so a bad query string costs a click, not the page.
  const [searchParams] = useSearchParams();
  const requestedOperation = searchParams.get('operation');
  const isOperation = (v: string | null): v is BundleOperation => v === 'expand' || v === 'merge' || v === 'update';
  const initialOperation: BundleOperation = isOperation(requestedOperation) ? requestedOperation : 'merge';
  const [operation, setOperation] = useState<BundleOperation>(initialOperation);
  const [status, setStatus] = useState<BundleStatus>('Active');
  // Blank, not '0'. For expand a price is optional and blank means "leave the
  // bundle product's price alone" — defaulting to 0 would send a real zero and
  // price the bundle free. Merge rejects a blank price with its own message.
  const [priceStr, setPriceStr] = useState('');
  const [parentVariantId, setParentVariantId] = useState<string | undefined>(undefined);
  const [parentTitle, setParentTitle] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [updatePriceAdjustment, setUpdatePriceAdjustment] = useState('');
  const [updateTitleOverride, setUpdateTitleOverride] = useState('');
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Populate form state from the loaded bundle exactly once — react-query
  // may hand us a new object reference on background refetch and we don't
  // want to clobber in-progress edits.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!isEdit || !bundle || initializedRef.current) return;
    setName(bundle.name);
    setOperation(bundle.operation);
    setStatus(bundle.status);
    const bundlePrice = moneyAmount(bundle.price);
    setPriceStr(bundlePrice != null ? String(bundlePrice) : '');
    setParentVariantId(bundle.parentVariantId);
    setItems(bundle.items.map((it) => ({
      variantId: it.variantId,
      name: it.name,
      qty: it.qty,
      price: moneyAmount(it.price),
      ...(it.priceAdjustment ? { priceAdjustment: moneyAmount(it.priceAdjustment) ?? undefined } : {}),
      ...(it.titleOverride ? { titleOverride: it.titleOverride } : {}),
    })));
    if (bundle.operation === 'update' && bundle.items[0]) {
      const [override] = bundle.items;
      const overrideAdjustment = moneyAmount(override.priceAdjustment ?? null);
      setUpdatePriceAdjustment(overrideAdjustment != null ? String(overrideAdjustment) : '');
      setUpdateTitleOverride(override.titleOverride ?? '');
    }
    initializedRef.current = true;
  }, [isEdit, bundle]);

  // Every variant currently on screen — parent plus components — resolved in
  // one Admin round trip. Deliberately not persisted: the app stores ids, and
  // Shopify stays the source of truth for names.
  const variantIds = [parentVariantId, ...items.map((it) => it.variantId)]
    .filter((v): v is string => Boolean(v));
  const { data: variantData, isError: variantsUnresolved } = useVariantsQuery(variantIds);
  const resolvedVariants = new Map<string, ResolvedVariant>(
    (variantData?.variants ?? []).map((v) => [v.id, v]),
  );

  const createMutation = useCreateBundle();
  const updateMutation = useUpdateBundle();
  const deleteMutation = useDeleteBundle();
  const isSaving = createMutation.isPending || updateMutation.isPending;

  if (isEdit && isLoading) {
    return (
      <Page title="Bundle" backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}>
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spinner accessibilityLabel="Loading bundle" />
        </div>
      </Page>
    );
  }

  if (isEdit && error && !isNotFound) {
    return (
      <Page title="Bundle" backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}>
        <Banner tone="critical">{error.message}</Banner>
      </Page>
    );
  }

  if (isEdit && !bundle) {
    return (
      <Page title="Bundle not found" backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}>
        <Card><Text as="p">This bundle doesn’t exist. It may have been deleted.</Text></Card>
      </Page>
    );
  }

  const titleFor = (variantId: string) => titles[variantId] ?? shortVariantLabel(variantId);

  /**
   * Opens the product picker (variants grouped under their product, as in the
   * admin's own "Select products" dialog) for merge items / expand components.
   *
   * The current items are pre-checked, which means the picker's result is the
   * merchant's full intent — unchecking there removes the item. That only
   * holds when every item could be pre-selected; when some couldn't (names
   * still resolving, or a variant deleted in Shopify) the result is merged in
   * instead, so an item the picker never showed as checked isn't silently
   * dropped.
   */
  const pickItems = async () => {
    if (!pickerAvailable) return;
    try {
      const { selectionIds, complete } = selectionIdsFromVariants(
        items.map((it) => it.variantId),
        resolvedVariants,
      );
      const result = await shopify.resourcePicker({
        type: 'product',
        multiple: true,
        action: 'select',
        selectionIds,
      });
      if (!result) return;

      const picked = flattenPickerSelection(result);
      setTitles((prev) => ({
        ...prev,
        ...Object.fromEntries(picked.map((v) => [v.variantId, v.title])),
      }));
      setItems((prev) => {
        const next = picked.map((v) => {
          const existing = prev.find((p) => p.variantId === v.variantId);
          // Keep the quantity the merchant already typed for a variant that
          // was already in the bundle.
          return {
            variantId: v.variantId, name: v.title, qty: existing?.qty ?? 1, price: v.price ?? null,
          };
        });
        if (complete) return next;
        const keptIds = new Set(next.map((it) => it.variantId));
        return [...prev.filter((it) => !keptIds.has(it.variantId)), ...next];
      });
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to open the product picker.');
    }
  };

  /**
   * Opens the product picker for the bundle's single parent/target variant.
   *
   * `multiple: false` still lets a merchant tick several variants of one
   * product (App Bridge documents this), and a bundle has exactly one parent —
   * so extra ticks are dropped and called out rather than silently ignored.
   */
  const pickParentVariant = async () => {
    if (!pickerAvailable) return;
    try {
      const { selectionIds } = selectionIdsFromVariants(
        parentVariantId ? [parentVariantId] : [],
        resolvedVariants,
      );
      const result = await shopify.resourcePicker({
        type: 'product',
        multiple: false,
        action: 'select',
        selectionIds,
      });
      if (!result) return;

      const picked = flattenPickerSelection(result);
      if (picked.length === 0) return;

      const [parent] = picked;
      setParentVariantId(parent.variantId);
      setParentTitle(parent.title);
      if (picked.length > 1) {
        setBannerError(
          `A bundle has one parent variant — kept “${parent.title}” and ignored the other ${picked.length - 1} selected.`,
        );
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to open the product picker.');
    }
  };

  const removeItem = (variantId: string) => setItems((prev) => prev.filter((it) => it.variantId !== variantId));

  const updateItemQty = (variantId: string, qtyStr: string) => {
    const parsed = parseInt(qtyStr, 10);
    const qty = Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_EXPAND_QTY, parsed)) : 1;
    setItems((prev) => prev.map((it) => (it.variantId === variantId ? { ...it, qty } : it)));
  };

  // `null` means "unknown", never zero — an item whose price hasn't resolved
  // yet must not silently contribute $0 to the total, which would
  // understate it (see web/bundles/preview.ts).
  const sumOfItems = sumItemPrices(items);
  const priceNum = parseFloat(priceStr) || 0;

  /**
   * What `price` to put on the wire.
   *
   * `merge` always needs one — the bundle has no price of its own without it.
   * `expand` is optional: the bundle product already has a price, and blank
   * means "don't adjust it". `update` has no bundle-level price at all.
   */
  function priceSentForOperation(
    op: BundleOperation,
    raw: string,
    parsed: number,
  ): number | undefined {
    if (op === 'merge') return parsed;
    if (op === 'expand') return raw.trim() === '' ? undefined : parsed;
    return undefined;
  }
  const save = sumOfItems != null ? Math.max(0, sumOfItems - priceNum) : null;
  const selectedOp = getOp(operation);
  // Genuinely optional, not guessed: before the plan query resolves (or if it
  // errors) we do not know the shop's currency, and guessing one (e.g. 'USD')
  // would silently mislabel every price on screen. `showMoney` renders the em
  // dash for both an unknown currency and an unknown amount.
  const currencyCode = planData?.currencyCode;
  const showMoney = (n: number | null) => (
    currencyCode !== undefined && n !== null
      ? formatMoney({ amount: String(n), currencyCode })
      : formatMoney(null)
  );
  // The same rule for money INPUTS: the shop's own symbol, or none at all while
  // the currency is unknown. Never a hardcoded `$` — it would assert USD on an
  // AUD or JPY shop just as the old read-path helpers did.
  const moneyPrefix = currencySymbol(currencyCode);

  const updateGate = gateOperation('update', updateOpEligible);
  const isUpdateLocked = operation === 'update' && !updateGate.enabled;

  // Variants Shopify no longer knows about — derived straight from the same
  // `/api/variants` response `resolvedVariants` is built from, rather than a
  // separate effect/state: there's nothing async left to wait on once that
  // query has answered, so a second piece of state would just be able to go
  // stale relative to it.
  const deadVariantIds = new Set(
    (variantData?.variants ?? []).filter((v) => !v.exists).map((v) => v.id),
  );
  const deadItems = items.filter((it) => deadVariantIds.has(it.variantId));

  // The target variant is NOT a bundle item, so it needs its own branch: it
  // cannot be "removed" the way a component can — the bundle needs one — so the
  // only fix is to choose a different variant, and the copy has to say that.
  // The server rejects a save whose target is gone (unless the bundle ends up
  // Draft or Ended), so surfacing it here is what stops that being a surprise.
  const targetVariantDeleted = parentVariantId !== undefined
    && deadVariantIds.has(parentVariantId);

  const canSave = name.trim().length > 0
    && (operation === 'update' ? Boolean(parentVariantId) : Boolean(parentVariantId) && items.length > 0);
  // `canSave` already blocks the primary action when a merge/expand bundle has
  // zero items (including the case where removing every dead item empties
  // it), but a disabled button with no banner is a dead end — the merchant
  // has no way to tell *why* Save stopped working.
  const needsItemsToSave = operation !== 'update' && items.length === 0;

  const buildInput = (nextStatus: BundleStatus): BundleInput => {
    const trimmedName = name.trim();
    if (operation === 'update') {
      const overrideItem: BundleItemInput | undefined = parentVariantId
        ? {
          variantId: parentVariantId,
          qty: 1,
          priceAdjustment: updatePriceAdjustment ? parseFloat(updatePriceAdjustment) : undefined,
          titleOverride: updateTitleOverride.trim() || undefined,
        }
        : undefined;
      return {
        name: trimmedName,
        operation,
        items: overrideItem ? [overrideItem] : [],
        status: nextStatus,
      };
    }
    return {
      name: trimmedName,
      operation,
      items: items.map((it) => ({
        variantId: it.variantId,
        qty: it.qty,
        ...(it.priceAdjustment !== undefined ? { priceAdjustment: it.priceAdjustment } : {}),
        ...(it.titleOverride ? { titleOverride: it.titleOverride } : {}),
      })),
      parentVariantId,
      // Expand carries a price now as well. Blank is meaningful — it means
      // "leave the line at whatever the bundle product costs" — so an empty
      // field sends nothing rather than a zero, which would read as free.
      price: priceSentForOperation(operation, priceStr, priceNum),
      status: nextStatus,
    };
  };

  const handleSave = async () => {
    setBannerError(null);
    const nextStatus: BundleStatus = isUpdateLocked ? 'Draft' : status;
    const input = buildInput(nextStatus);
    try {
      if (isEdit && id) {
        await updateMutation.mutateAsync({ id, input });
      } else {
        await createMutation.mutateAsync(input);
      }
      navigate('/bundles');
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to save bundle.');
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setBannerError(null);
    try {
      await deleteMutation.mutateAsync(id);
      navigate('/bundles');
    } catch (err) {
      // Keep the merchant on the page with the reason: the bundle still
      // exists, so sending them back to a list that still shows it would be
      // the one outcome that misrepresents what happened.
      setConfirmingDelete(false);
      setBannerError(err instanceof Error ? err.message : 'Failed to delete bundle.');
    }
  };

  const mutationError = createMutation.error ?? updateMutation.error ?? deleteMutation.error;

  let primaryActionLabel: string;
  if (isUpdateLocked) primaryActionLabel = 'Save draft';
  else if (isEdit) primaryActionLabel = 'Save bundle';
  else primaryActionLabel = 'Create bundle';

  return (
    <Page
      backAction={{ content: 'Bundles', onAction: () => navigate('/bundles') }}
      title={isEdit ? 'Edit bundle' : 'Create bundle'}
      subtitle="Define what the bundle is. Scheduling happens later in a bundle campaign."
      primaryAction={{
        content: primaryActionLabel,
        onAction: handleSave,
        loading: isSaving,
        disabled: !canSave || isSaving,
      }}
      secondaryActions={
        isEdit
          ? [
            { content: 'Discard', onAction: () => navigate('/bundles') },
            {
              content: 'Delete bundle',
              destructive: true,
              onAction: () => setConfirmingDelete(true),
              disabled: isSaving || deleteMutation.isPending,
            },
          ]
          : [{ content: 'Discard', onAction: () => navigate('/bundles') }]
      }
    >
      <Modal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={`Delete ${bundle?.name ?? 'this bundle'}?`}
        primaryAction={{
          content: 'Delete bundle',
          destructive: true,
          onAction: handleDelete,
          loading: deleteMutation.isPending,
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => setConfirmingDelete(false),
            disabled: deleteMutation.isPending,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              This removes the bundle and its components from the app. It can&apos;t be undone.
            </Text>
            <Text as="p" tone="subdued">
              The products themselves aren&apos;t touched — only this bundle. Shoppers will stop
              seeing it at checkout.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
      <BlockStack gap="400">
        {(bannerError || mutationError) && (
          <Banner tone="critical" onDismiss={() => setBannerError(null)}>
            {bannerError ?? mutationError?.message}
          </Banner>
        )}
        {variantsUnresolved && (
          <Banner tone="warning">
            Couldn&apos;t load product names from Shopify, so variants are shown by id. Editing and
            saving still work.
          </Banner>
        )}
        {isUpdateLocked && (
          <Banner tone="warning" title="This bundle can only be saved as a Draft">
            <p>Overriding a cart line&apos;s price or title requires Shopify Plus. It won&apos;t go live until this store is on Plus and the bundle is re-saved.</p>
          </Banner>
        )}
        {targetVariantDeleted && (
          <Banner tone="critical" title="This bundle's target product was deleted in Shopify">
            <BlockStack gap="200">
              <Text as="p">
                {operation === 'merge'
                  ? 'Merged carts have nothing left to display, so this bundle cannot be saved until you choose a new target variant.'
                  : 'This bundle has nothing left to attach to, so it cannot be saved until you choose a new target variant.'}
                {' '}
                You can still set it to Draft to switch it off.
              </Text>
              <InlineStack gap="200">
                <Button
                  onClick={pickParentVariant}
                  disabled={!pickerAvailable}
                  accessibilityLabel="Choose a new target variant for this bundle"
                >
                  Choose a new target variant
                </Button>
              </InlineStack>
              {!pickerAvailable && (
                <Text as="span" variant="bodySm" tone="subdued">
                  The variant picker is available inside the Shopify admin.
                </Text>
              )}
            </BlockStack>
          </Banner>
        )}
        {deadItems.length > 0 && (
          <Banner tone="critical" title="Some products were deleted in Shopify">
            <BlockStack gap="200">
              {deadItems.map((item) => {
                // showMoney renders the em dash for both "no price on record" and
                // "currency not yet known" — a bare dash character read out by a
                // screen reader conveys nothing, so the words are added for
                // assistive tech only; the visible row is unchanged.
                const priceUnknown = item.price === null || currencyCode === undefined;
                return (
                  <InlineStack key={item.variantId} gap="200" blockAlign="center">
                    <Text as="span">
                      <strong>{item.name}</strong>
                      {' — '}
                      {showMoney(item.price)}
                      {priceUnknown && (
                        <Box as="span" visuallyHidden>
                          {' (price unknown)'}
                        </Box>
                      )}
                    </Text>
                    <Button
                      variant="plain"
                      tone="critical"
                      accessibilityLabel={`Remove ${item.name} from bundle`}
                      onClick={() => removeItem(item.variantId)}
                    >
                      Remove from bundle
                    </Button>
                  </InlineStack>
                );
              })}
              <Text as="span" variant="bodySm" tone="subdued">
                Their last known price is shown. Removing one takes effect when you save.
              </Text>
            </BlockStack>
          </Banner>
        )}
        {needsItemsToSave && (
          <Banner tone="warning" title="This bundle has no items">
            <p>
              {`${operation === 'merge' ? 'Merge' : 'Expand'} bundles need at least one variant to save. Add one below, or discard this bundle if it's no longer needed.`}
            </p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: ['twoThirds', 'oneThird'] }} gap="400">
          <BlockStack gap="400">
            <Card>
              <TextField
                label="Bundle name"
                value={name}
                onChange={setName}
                autoComplete="off"
                requiredIndicator
                helpText="Shown internally and used to label the bundle."
              />
            </Card>

            {/* ── MERGE ── */}
            {operation === 'merge' && (
              <>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Bundle line variant
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      The variant that represents the merged line at checkout.
                    </Text>
                    <InlineStack gap="200" blockAlign="center">
                      {parentVariantId ? (
                        <Tag onRemove={() => { setParentVariantId(undefined); setParentTitle(undefined); }}>
                          <VariantLabel
                            resolved={resolvedVariants.get(parentVariantId)}
                            fallback={parentTitle ?? titleFor(parentVariantId)}
                            layout="inline"
                          />
                        </Tag>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">No variant chosen.</Text>
                      )}
                      <Button onClick={pickParentVariant} disabled={!pickerAvailable}>
                        {parentVariantId ? 'Change variant' : 'Choose variant'}
                      </Button>
                    </InlineStack>
                    {!pickerAvailable && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Product picker is available inside the Shopify admin.
                      </Text>
                    )}
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Merged variants
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      These cart lines are merged into one bundle line at checkout.
                    </Text>
                    {items.length > 0 ? (
                      <InlineStack gap="150">
                        {items.map((item) => (
                          <Tag key={item.variantId} onRemove={() => removeItem(item.variantId)}>
                            <VariantLabel
                              resolved={resolvedVariants.get(item.variantId)}
                              fallback={titleFor(item.variantId)}
                              layout="inline"
                            />
                          </Tag>
                        ))}
                      </InlineStack>
                    ) : (
                      <Text as="span" variant="bodySm" tone="subdued">
                        No variants yet.
                      </Text>
                    )}
                    <InlineStack gap="200" blockAlign="center">
                      <Button onClick={pickItems} disabled={!pickerAvailable}>
                        Add variants
                      </Button>
                      {!pickerAvailable && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          Product picker is available inside the Shopify admin.
                        </Text>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Price
                    </Text>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <TextField
                        label="Bundle price"
                        type="number"
                        prefix={moneyPrefix}
                        value={priceStr}
                        onChange={setPriceStr}
                        autoComplete="off"
                        min={0}
                      />
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd">
                          Sum of items
                        </Text>
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd" tone="subdued" textDecorationLine="line-through">
                            {showMoney(sumOfItems)}
                          </Text>
                          {save != null && save > 0 && <Badge tone="success">{`Save ${showMoney(save)}`}</Badge>}
                        </InlineStack>
                      </BlockStack>
                    </InlineGrid>
                  </BlockStack>
                </Card>
              </>
            )}

            {/* ── EXPAND ── */}
            {operation === 'expand' && (
              <>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Bundle price
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Optional. Leave blank to charge whatever the bundle product costs in Shopify.
                      Set a price and the line is discounted down to it at checkout.
                    </Text>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <TextField
                        label="Bundle price"
                        labelHidden
                        type="number"
                        prefix={moneyPrefix}
                        value={priceStr}
                        onChange={setPriceStr}
                        autoComplete="off"
                        min={0}
                        placeholder="Bundle product price"
                        helpText="Must be below the bundle product's own price."
                      />
                    </InlineGrid>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Parent product
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      The line a shopper adds; it expands into the components below at checkout.
                    </Text>
                    <InlineStack gap="200" blockAlign="center">
                      {parentVariantId ? (
                        <Tag onRemove={() => { setParentVariantId(undefined); setParentTitle(undefined); }}>
                          <VariantLabel
                            resolved={resolvedVariants.get(parentVariantId)}
                            fallback={parentTitle ?? titleFor(parentVariantId)}
                            layout="inline"
                          />
                        </Tag>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">No variant chosen.</Text>
                      )}
                      <Button onClick={pickParentVariant} disabled={!pickerAvailable}>
                        {parentVariantId ? 'Change variant' : 'Choose variant'}
                      </Button>
                    </InlineStack>
                    {!pickerAvailable && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Product picker is available inside the Shopify admin.
                      </Text>
                    )}
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">
                        Components
                      </Text>
                      <Badge>{`${items.length} lines`}</Badge>
                    </InlineStack>
                    <Divider />
                    {items.map((c) => (
                      <InlineGrid key={c.variantId} columns={{ xs: 1, sm: 3 }} gap="300">
                        <VariantLabel
                          resolved={resolvedVariants.get(c.variantId)}
                          fallback={titleFor(c.variantId)}
                        />
                        <TextField
                          label="Quantity"
                          type="number"
                          value={String(c.qty)}
                          onChange={(v) => updateItemQty(c.variantId, v)}
                          min={1}
                          max={MAX_EXPAND_QTY}
                          autoComplete="off"
                          helpText={`Max ${MAX_EXPAND_QTY.toLocaleString('en-US')}`}
                        />
                        <InlineStack gap="150" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {showMoney(c.price)}
                            {' '}
                            / unit
                          </Text>
                          <Button variant="tertiary" tone="critical" onClick={() => removeItem(c.variantId)}>
                            Remove
                          </Button>
                        </InlineStack>
                      </InlineGrid>
                    ))}
                    <InlineStack gap="200" blockAlign="center">
                      <Button onClick={pickItems} disabled={!pickerAvailable}>
                        Add components
                      </Button>
                      {!pickerAvailable && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          Product picker is available inside the Shopify admin.
                        </Text>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Card>
              </>
            )}

            {/* ── UPDATE ── (Shopify Plus only; may still be saved as a Draft otherwise) ── */}
            {operation === 'update' && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Line override
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    {parentVariantId ? (
                      <Tag onRemove={() => { setParentVariantId(undefined); setParentTitle(undefined); }}>
                        {parentTitle ?? titleFor(parentVariantId)}
                      </Tag>
                    ) : (
                      <Text as="span" variant="bodySm" tone="subdued">No target variant chosen.</Text>
                    )}
                    <Button onClick={pickParentVariant} disabled={!pickerAvailable}>
                      {parentVariantId ? 'Change variant' : 'Choose target variant'}
                    </Button>
                  </InlineStack>
                  {!pickerAvailable && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Variant picker is available inside the Shopify admin.
                    </Text>
                  )}
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <TextField
                      label="New price"
                      type="number"
                      prefix={moneyPrefix}
                      value={updatePriceAdjustment}
                      onChange={setUpdatePriceAdjustment}
                      autoComplete="off"
                    />
                    <TextField
                      label="New title"
                      value={updateTitleOverride}
                      onChange={setUpdateTitleOverride}
                      autoComplete="off"
                    />
                  </InlineGrid>
                </BlockStack>
              </Card>
            )}
          </BlockStack>

          {/* Right rail — operation reference + real Shopify limits */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Operation
              </Text>
              <InlineStack gap="150" blockAlign="center">
                <Badge tone={OP_TONE[operation]}>
                  {selectedOp.label}
                </Badge>
                {operation === 'update' && !updateGate.enabled && <Badge tone="warning">{updateGate.reason}</Badge>}
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                {selectedOp.description}
              </Text>
              <Box>
                <OperationPicker
                  label="Change operation"
                  variant="plain"
                  selected={operation}
                  updateOpEligible={updateOpEligible}
                  onSelect={setOperation}
                />
              </Box>
              {isEdit && (
                <Text as="span" variant="bodySm" tone="subdued">
                  Changing this rewrites what the bundle does at checkout, and clears the
                  metafield the old operation wrote.
                </Text>
              )}
              <Divider />
              <Text as="span" variant="headingXs" tone="subdued">
                CART TRANSFORM LIMITS
              </Text>
              <List>
                {CART_TRANSFORM_LIMITS.map((l) => (
                  <List.Item key={l}>{l}</List.Item>
                ))}
              </List>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
