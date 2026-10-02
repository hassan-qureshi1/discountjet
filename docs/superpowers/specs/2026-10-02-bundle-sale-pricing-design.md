# Bundle sale pricing — design

**Date:** 2026-10-02
**Status:** awaiting review

## Goal

A campaign can put its bundles **on sale**: for the campaign's window, each
bundle's parent product variant carries a reduced `price` with the component
sum as `compareAtPrice`, so the saving is visible on the product page and in
collections rather than appearing only at checkout.

## Why this is new

Everything the app does today is **additive**: it writes app-owned metafields
and creates app-owned discounts. A failure leaves a discount that does not
apply. Nothing is lost.

This feature **overwrites merchant data** — a variant's own price. That single
difference drives most of the design below. If the restore never runs, the
bundle sits at its sale price indefinitely, and the price it had before is gone
unless we stored it.

## The three states

`compareAtPrice` is not something the sale introduces. It is a standing
property of a bundle — what the components would cost bought separately — so
the strikethrough is permanent and only `price` moves.

Naming matters here, because two different numbers are both called "price":

- **`bundle.price`** — the field the merchant edits in the bundle form. This is
  the **sale** price.
- **the parent variant's `price` in Shopify** — what the product actually
  costs right now. Normally the component sum; the sale moves it.

| | parent variant's `price` in Shopify | `compareAtPrice` |
|---|---|---|
| Before sale | whatever the merchant set (normally the component sum) | sum of components |
| During sale | `bundle.price` | sum of components |
| After sale | restored to exactly its pre-sale value | sum of components |

The compare-at is prefilled with the component sum and may be overridden.

## Data

Two new columns on `bundle`:

| Column | Type | Meaning |
|---|---|---|
| `compare_at_price` | `integer` (minor units), nullable | What to publish as `compareAtPrice`. Null means "use the component sum", so an untouched bundle needs no backfill. |
| `pre_sale_price` | `integer` (minor units), nullable | The parent's `price` captured immediately before the first sale write. Null means "not on sale". |

`pre_sale_price` is the whole restore guarantee and the only genuinely new
risk. It is:

- **written once**, in the same update that applies the sale price, never
  overwritten while non-null — so a second activation pass cannot capture the
  *sale* price as if it were the original;
- **cleared only after** the restore write to Shopify has succeeded — so a
  failed restore leaves the row visibly mid-sale and the next cron pass
  retries it, rather than forgetting what to restore;
- **the signal for "this bundle is on sale"**, independent of campaign status,
  so a bundle can always be restored even if its campaign is gone.

No `docs/erd.dbml` change is needed beyond these two columns, which are added
in the same commit as the schema edit and the migration.

## Where the writes happen

The existing cron (`src/lifecycle/bundleSchedule.ts`, every 5 minutes) already
walks due bundles, derives a target status from the window and writes the
composition metafield. The price write goes in the **same pass, for the same
bundle, under the same `shouldBeLive(target)` branch** — not a second
scheduler. One sweep, one source of truth about what a window means.

- `shouldBeLive(target)` and `pre_sale_price IS NULL` → capture the parent's
  current price into `pre_sale_price`, then write `price` = bundle price and
  `compareAtPrice` = `compare_at_price ?? component sum`.
- `!shouldBeLive(target)` and `pre_sale_price IS NOT NULL` → write `price` =
  `pre_sale_price`, leave `compareAtPrice` at the component sum, then clear
  `pre_sale_price`.
- Either condition already satisfied → do nothing. The pass is idempotent.

Writes go through `productVariantsBulkUpdate`, the same mutation used to set
these bundles' prices today. The parent is one variant per bundle, so no
batching beyond what one campaign's bundles need.

## Failure modes, and what happens

| Failure | Behaviour |
|---|---|
| Shopify rejects the sale write | `scheduleError` records it; status is not advanced; the next pass retries. The bundle is not left half-applied, because `pre_sale_price` is written in the same update as the sale price. |
| Shopify rejects the restore | `pre_sale_price` stays set, so the bundle still reads as on sale and the next pass retries. It cannot be forgotten. |
| Cron misses the window end | The next pass restores. Late, not lost — the restore is driven by `pre_sale_price`, not by catching the boundary. |
| Campaign deleted mid-sale | `bundle.campaign_id` is `ON DELETE SET NULL`, but `pre_sale_price` survives. The bundle's own window still ends and the restore still runs. |
| App uninstalled mid-sale | Prices stay at sale. Out of scope to fix from inside the app, but called out here so it is a known limitation rather than a surprise. |
| Merchant edits the parent price in Shopify during a sale | The restore will overwrite their edit with `pre_sale_price`. Accepted: the campaign owns the price for its window. |

## Interactions with what already exists

**The cart transform becomes a no-op during the sale.** An expand bundle's
target price will equal the line subtotal, so `bundle_expander` correctly emits
no adjustment. The discount has *moved* from checkout into the price tag; the
shopper pays the same either way. This is correct behaviour and must not be
"fixed".

**The bundle price field becomes read-only while a campaign owns the bundle.**
During the sale, parent price equals bundle price, so
`assertExpandPriceBelowParent` would reject any save — the app rejecting an
edit because of its own sale. Rather than special-case the validator, the
editor locks the price field for the duration, exactly as it already locks the
Schedule card. One rule: **a live campaign owns its bundles' schedule and
price.**

**The parent card's comparison line** already warns when components exceed the
parent's price. It keeps working unchanged, and becomes more useful: it is the
same number now published as `compareAtPrice`.

## Scope

**In:** bundles already created, selected into a campaign through the existing
Bundles step, regardless of their own status. Price and compare-at on the
parent variant only.

**Out:** collections, storewide sales, arbitrary products not backed by a
bundle, per-variant sale prices, and scheduled price changes outside a
campaign.

## Open question for review

The earlier answer in conversation was "a third member type, alongside
discounts and bundles". This spec instead **extends the campaign's existing
bundle membership**, because the follow-up clarification was "just the bundle
already created … user can select from the bundles that were created".

Extending the existing membership means: no third table, no selecting the same
bundle twice, and a campaign's bundles get their metafield *and* their price
scheduled by one act of selection. If the intent was genuinely a separate
member type — a campaign scheduling a price change for a bundle it has not
otherwise attached — say so and this section is what changes.
