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
} from '@shopify/polaris';
import { DeleteIcon } from '@shopify/polaris-icons';
import {
  useBundleQuery, useCreateBundle, useDeleteBundle, useShopPlanQuery, useUpdateBundle,
  useVariantsQuery,
} from '../bundles/hooks';
import type { BundleInput, BundleItemInput, ResolvedVariant } from '../bundles/api';
import { useCampaign } from '../campaigns/hooks';
import { isCampaignLocking } from '../../src/lib/campaignStatus';
import { flattenPickerSelection, selectionIdsFromVariants } from '../lib/picker';
import { OperationPicker } from '../components/OperationPicker';
import { ScheduleCard } from '../components/ScheduleCard';
import { VariantLabel } from '../components/VariantLabel';
import { VariantLinks } from '../components/VariantLinks';
import { PriceCard } from '../components/PriceCard';
import { VariantSelectCard } from '../components/VariantSelectCard';
import {
  CART_TRANSFORM_LIMITS,
  gateOperation,
  getOp,
  MAX_EXPAND_QTY,
  OP_TONE,
} from '../bundles/ops';
import { STATUS_TONE } from '../bundles/statusTone';
import type { BundleOperation, BundleStatus } from '../types/bundles';
import { formatMoney, moneyAmount, currencySymbol } from '../lib/money';
import { sumItemPrices } from '../bundles/preview';
import {
  fromUtcIso, toUtcIso,
} from '../lib/schedule';

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

/** `gid://shopify/ProductVariant/123` → `Variant #123`, used when a picked
 * variant's title hasn't been captured yet (e.g. items loaded from an
 * existing bundle, before the merchant re-opens the picker). */
const shortVariantLabel = (variantId: string) => {
  const match = variantId.match(/(\d+)$/);
  return match ? `Variant #${match[1]}` : variantId;
};

/** Shopify's placeholder title for a product with no variant options — never
 * worth showing next to the product name. */

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

  // A campaign that PUBLISHED this bundle onto its window owns the schedule
  // for as long as it's still locking (Scheduled/Published) — editing the
  // window here would silently desynchronise the bundle from the campaign's
  // discounts, which fire on the campaign's dates regardless of what this
  // form saves. `isCampaignLocking` is imported rather than re-implemented so
  // this can never disagree with the campaign screens about which statuses
  // lock. A campaign whose window has ENDED no longer locks, so the bundle
  // becomes editable again with no further action needed.
  const { data: owningCampaignData } = useCampaign(bundle?.campaignId);
  const owningCampaign = owningCampaignData?.campaign;
  const scheduleLocked = Boolean(owningCampaign) && isCampaignLocking(owningCampaign!.status);

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
  // The window is held as the merchant typed it — local date + local time —
  // and converted to UTC only on save. Holding UTC here would mean converting
  // on every keystroke.
  const [hasStart, setHasStart] = useState(false);
  const [hasEnd, setHasEnd] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('23:59');
  // Blank, not '0'. For expand a price is optional and blank means "leave the
  // bundle product's price alone" — defaulting to 0 would send a real zero and
  // price the bundle free. Merge rejects a blank price with its own message.
  const [priceStr, setPriceStr] = useState('');
  // Blank means "no stored compare-at" (use the component sum) and is sent as
  // an explicit null — never coerced to 0, which would strike through £0.00.
  const [compareAtStr, setCompareAtStr] = useState('');
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
    if (bundle.scheduleStart) {
      const { date, time } = fromUtcIso(bundle.scheduleStart);
      setHasStart(true);
      setStartDate(date);
      setStartTime(time);
    }
    if (bundle.scheduleEnd) {
      const { date, time } = fromUtcIso(bundle.scheduleEnd);
      setHasEnd(true);
      setEndDate(date);
      setEndTime(time);
    }
    const bundlePrice = moneyAmount(bundle.price);
    setPriceStr(bundlePrice != null ? String(bundlePrice) : '');
    const bundleCompareAt = moneyAmount(bundle.compareAtPrice ?? null);
    setCompareAtStr(bundleCompareAt != null ? String(bundleCompareAt) : '');
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
  // `expand` treats a blank price as "leave the product's own price alone",
  // so there is no bundle price to compare the components against and no
  // saving to claim. `merge` always has a price, so only the expand card reads this.
  const hasExpandPrice = priceStr.trim() !== '';
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
  // The parent variant's own price, already resolved for its title and
  // thumbnail — no extra lookup. `undefined` while the resolve is in flight or
  // when the variant no longer exists, in which case the card shows no price
  // rather than a guessed one.
  const parentResolved = parentVariantId ? resolvedVariants.get(parentVariantId) : undefined;
  const parentPrice = parentResolved?.price != null ? Number(parentResolved.price) : null;

  /**
   * How the components relate to the parent's list price.
   *
   * This is the state that produces the "nothing to discount" rejection: an
   * expand bundle's price has to sit below the parent product's own price, so
   * a parent priced under its components leaves no room to discount into and
   * every price the merchant types is refused. Saying so here — next to both
   * numbers — turns a 400 on save into something visible while they are still
   * choosing the product.
   */
  const parentComparison = (() => {
    if (operation !== 'expand' || parentPrice == null || sumOfItems == null) return null;
    if (sumOfItems > parentPrice) {
      return (
        <Text as="span" variant="bodySm" tone="critical">
          {`Components total ${showMoney(sumOfItems)}, more than this product's `
            + `${showMoney(parentPrice)}. Raise the product's price in Shopify, or the `
            + 'bundle price will have nothing to discount from.'}
        </Text>
      );
    }
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {`Components total ${showMoney(sumOfItems)}.`}
      </Text>
    );
  })();

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

  // Converted once, and reused by both the preview and the save — so what the
  // merchant is shown is exactly what gets sent.
  let scheduleStart: string | null = null;
  let scheduleEnd: string | null = null;
  let scheduleFieldError: string | null = null;
  try {
    // A ticked checkbox with a blank date is NOT "unset" — sending `null` for
    // that bound means no bound at all, i.e. permanently live. Block the save
    // and tell the merchant, rather than silently making the bundle live now
    // when they believe they scheduled it for later.
    if (hasStart && !startDate) {
      scheduleFieldError = 'Enter a start date, or clear "Set a start date" to leave it unscheduled.';
    } else if (hasEnd && !endDate) {
      scheduleFieldError = 'Enter an end date, or clear "Set an end date" to leave it unscheduled.';
    } else {
      if (hasStart && startDate) scheduleStart = toUtcIso(startDate, startTime);
      if (hasEnd && endDate) scheduleEnd = toUtcIso(endDate, endTime);
      if (scheduleStart && scheduleEnd && scheduleStart >= scheduleEnd) {
        scheduleFieldError = 'The start must be before the end.';
      }
    }
  } catch {
    scheduleFieldError = 'Enter a valid date and time.';
  }

  // Mirrors the server's deriveStatus so the merchant sees `Scheduled` BEFORE
  // saving rather than after. The server still decides; this is a preview.
  const previewStatus: BundleStatus = (() => {
    if (status === 'Draft') return 'Draft';
    const now = new Date().toISOString();
    if (scheduleEnd !== null && now >= scheduleEnd) return 'Ended';
    if (scheduleStart !== null && now < scheduleStart) return 'Scheduled';
    return 'Active';
  })();

  /**
   * What `compareAtPrice` to put on the wire (expand only): a number sets it,
   * blank sends an explicit null to clear it, and a locked field sends nothing
   * so the stored value is left untouched while a campaign owns the pricing.
   */
  const compareAtSent = (): number | null | undefined => {
    if (operation !== 'expand' || scheduleLocked) return undefined;
    const trimmed = compareAtStr.trim();
    if (trimmed === '') return null;
    const parsed = parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const buildInput = (nextStatus: BundleStatus): BundleInput => {
    const trimmedName = name.trim();
    const compareAt = compareAtSent();
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
        // An `update` bundle writes no metafield, so this column is the ONLY
        // record of which variant the override targets. Omitting it saved the
        // row with a null parent and the editor then had nothing to show —
        // the variant appeared to vanish on save.
        parentVariantId,
        status: nextStatus,
        scheduleStart,
        scheduleEnd,
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
      ...(compareAt !== undefined ? { compareAtPrice: compareAt } : {}),
      status: nextStatus,
      scheduleStart,
      scheduleEnd,
    };
  };

  /**
   * `statusOverride` is how "Save as draft" works on a CREATE. An existing
   * bundle has Activate/Deactivate in the More actions menu, but a new one has
   * no row to act on yet — without this, every bundle a merchant creates goes
   * live the moment they save it, with no way to stage one first.
   */
  const handleSave = async (statusOverride?: BundleStatus) => {
    if (scheduleFieldError) {
      setBannerError(scheduleFieldError);
      return;
    }
    setBannerError(null);
    // The plan lock still wins: an update-operation bundle the shop can't run
    // is a draft whatever the merchant clicked.
    const chosen: BundleStatus = statusOverride ?? status;
    const nextStatus: BundleStatus = isUpdateLocked ? 'Draft' : chosen;
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

  /**
   * Activate / Deactivate from the More actions menu.
   *
   * Saves IMMEDIATELY, the way Shopify's own discount page behaves — a merchant
   * who deactivates a live bundle expects it gone from checkout, not staged
   * behind a Save they might never press. `Draft` IS the deactivated state: the
   * route honours it as the manual off-switch and clears the transport, and the
   * scheduling cron skips the row entirely.
   *
   * Only `status` goes on the wire, so unsaved edits elsewhere on the form are
   * deliberately NOT swept along with it.
   */
  const handleSetStatus = async (next: 'Active' | 'Draft') => {
    if (!id) return;
    setBannerError(null);
    try {
      await updateMutation.mutateAsync({ id, input: { status: next } });
      setStatus(next);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to update the bundle status.');
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

  const busy = isSaving || deleteMutation.isPending;
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
        onAction: () => handleSave(),
        loading: isSaving,
        disabled: !canSave || isSaving,
      }}
      secondaryActions={
        isEdit || isUpdateLocked
          // Editing? Deactivate lives in More actions. Plan-locked? The primary
          // action is already "Save draft", so a second draft button would be
          // two buttons doing one thing.
          ? [{ content: 'Discard', onAction: () => navigate('/bundles') }]
          : [
            {
              content: 'Save as draft',
              onAction: () => handleSave('Draft'),
              disabled: !canSave || isSaving,
            },
            { content: 'Discard', onAction: () => navigate('/bundles') },
          ]
      }
      actionGroups={
        isEdit
          ? [{
            title: 'More actions',
            actions: [
              // One entry, not two: the label states what the click will DO,
              // which is how Shopify's own pages read. `Draft` is deactivated.
              status === 'Draft'
                ? {
                  content: 'Activate',
                  onAction: () => handleSetStatus('Active'),
                  // An update-operation bundle the shop's plan can't run is
                  // forced to Draft on save anyway — offering Activate would
                  // promise something the server will refuse.
                  disabled: busy || isUpdateLocked,
                }
                : {
                  content: 'Deactivate',
                  onAction: () => handleSetStatus('Draft'),
                  disabled: busy,
                },
              {
                content: 'Delete bundle',
                destructive: true,
                onAction: () => setConfirmingDelete(true),
                disabled: busy,
              },
            ],
          }]
          : undefined
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
                <VariantSelectCard
                  title="Bundle line variant"
                  description="The variant that represents the merged line at checkout."
                  selectedLabel={parentVariantId ? (
                    <VariantLabel
                      resolved={resolvedVariants.get(parentVariantId)}
                      fallback={parentTitle ?? titleFor(parentVariantId)}
                    />
                  ) : null}
                  selectedActions={parentVariantId ? (
                    <VariantLinks
                      resolved={resolvedVariants.get(parentVariantId)}
                      fallback={parentTitle ?? titleFor(parentVariantId)}
                    />
                  ) : null}
                  // No price or comparison line here: a merge bundle's
                  // adjustment is based on the COMPONENTS' sum, not on this
                  // variant's own price, so showing that price beside it would
                  // point at the wrong number.
                  removeLabel="Remove the bundle line variant"
                  onRemove={() => { setParentVariantId(undefined); setParentTitle(undefined); }}
                  onPick={pickParentVariant}
                  pickerAvailable={pickerAvailable}
                />

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

                <PriceCard
                  title="Price"
                  label="Bundle price"
                  value={priceStr}
                  onChange={setPriceStr}
                  prefix={moneyPrefix}
                  comparison={showMoney(sumOfItems)}
                  saving={save != null && save > 0 ? showMoney(save) : null}
                />
              </>
            )}

            {/* ── EXPAND ── */}
            {operation === 'expand' && (
              <>
                {/* `saving` is gated on a non-blank field, unlike `merge`. An
                    expand bundle's price is optional and `priceNum` falls back to
                    0 when blank, so an ungated badge would announce a saving equal
                    to the whole sum against a price the merchant never set. */}
                <PriceCard
                  title="Bundle price"
                  description="Optional. Leave blank to charge whatever the bundle product costs in Shopify. Set a price and the line is discounted down to it at checkout."
                  label="Bundle price"
                  labelHidden
                  value={priceStr}
                  onChange={setPriceStr}
                  prefix={moneyPrefix}
                  placeholder="Bundle product price"
                  helpText="Must be below the bundle product's own price."
                  comparison={showMoney(sumOfItems)}
                  saving={hasExpandPrice && save != null && save > 0 ? showMoney(save) : null}
                  disabled={scheduleLocked}
                  footer={(
                    <>
                      {scheduleLocked && owningCampaign && (
                        <Banner tone="info" title="This bundle's pricing is controlled by a campaign">
                          <p>
                            {'The campaign '}
                            <Link url={`/campaigns/${owningCampaign.id}`}>{owningCampaign.name}</Link>
                            {` sets the price and compare-at price for its window, so both are read-only while that campaign is ${owningCampaign.status}.`}
                          </p>
                        </Banner>
                      )}
                      <TextField
                        label="Compare-at price"
                        type="number"
                        prefix={moneyPrefix}
                        value={compareAtStr}
                        onChange={setCompareAtStr}
                        autoComplete="off"
                        min={0}
                        disabled={scheduleLocked}
                        placeholder={sumOfItems != null ? sumOfItems.toFixed(2) : undefined}
                        helpText="What the components cost separately. Shown struck through on the product page. Leave blank to use the sum of the components."
                      />
                    </>
                  )}
                />
                <VariantSelectCard
                  title="Parent product"
                  description="The line a shopper adds; it expands into the components below at checkout."
                  selectedLabel={parentVariantId ? (
                    <VariantLabel
                      resolved={resolvedVariants.get(parentVariantId)}
                      fallback={parentTitle ?? titleFor(parentVariantId)}
                    />
                  ) : null}
                  selectedActions={parentVariantId ? (
                    <VariantLinks
                      resolved={resolvedVariants.get(parentVariantId)}
                      fallback={parentTitle ?? titleFor(parentVariantId)}
                    />
                  ) : null}
                  // The number every bundle price on this screen is validated
                  // against — an expand bundle's price must sit below it. Shown
                  // here because a merchant otherwise has to open the Shopify
                  // admin to discover what they are being measured against.
                  priceLabel={parentPrice != null ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`${showMoney(parentPrice)} · list price`}
                    </Text>
                  ) : null}
                  footnote={parentComparison}
                  removeLabel="Remove the parent product"
                  onRemove={() => { setParentVariantId(undefined); setParentTitle(undefined); }}
                  onPick={pickParentVariant}
                  pickerAvailable={pickerAvailable}
                />

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
                          {/* Icon-only actions: the row already names the
                              product, so spelling out "Admin"/"Storefront"
                              beside it repeated what the row said. Each keeps
                              an accessibilityLabel naming the product, so the
                              button is never announced as bare "link". */}
                          <VariantLinks
                            resolved={resolvedVariants.get(c.variantId)}
                            fallback={titleFor(c.variantId)}
                          />
                          <Button
                            variant="tertiary"
                            tone="critical"
                            icon={DeleteIcon}
                            accessibilityLabel={`Remove ${titleFor(c.variantId)} from this bundle`}
                            onClick={() => removeItem(c.variantId)}
                          />
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

            {/* Full width, at the end of the page: the schedule is read after the
                merchant has decided what the bundle actually IS. Rendered ONCE
                here, outside the per-operation branches, so every operation
                (including merge and update) gets a schedule — the scheduling
                cron itself is generic over all three (see
                src/lifecycle/bundleSchedule.ts), so the UI must be too. */}
            <ScheduleCard
              value={{
                hasStart, startDate, startTime, hasEnd, endDate, endTime,
              }}
              onChange={(w) => {
                setHasStart(w.hasStart);
                setStartDate(w.startDate);
                setStartTime(w.startTime);
                setHasEnd(w.hasEnd);
                setEndDate(w.endDate);
                setEndTime(w.endTime);
              }}
              status={{ label: previewStatus, tone: STATUS_TONE[previewStatus] }}
              error={scheduleFieldError}
              lastFailure={bundle?.scheduleError ?? null}
              disabled={scheduleLocked}
              bannerSlot={scheduleLocked && owningCampaign ? (
                <Banner tone="info" title="This bundle's schedule is owned by a campaign">
                  <p>
                    {'The campaign '}
                    <Link url={`/campaigns/${owningCampaign.id}`}>{owningCampaign.name}</Link>
                    {` published this bundle onto its own window, so the schedule below is read-only while that campaign is ${owningCampaign.status}. Clone the campaign to change its window.`}
                  </p>
                </Banner>
              ) : undefined}
              startHelpText="Leave off to start as soon as the bundle is saved."
              endHelpText="Leave off to run until you switch the bundle off."
              footnote="Times are in your own timezone. The bundle goes live and comes down automatically within 5 minutes of each time."
              lastFailureDetail="It will be retried automatically. Saving the bundle also retries it."
            />
          </BlockStack>

          {/* Right rail — operation reference + real Shopify limits */}
          <BlockStack gap="400">

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
                    planName={planData?.planName}
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
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
