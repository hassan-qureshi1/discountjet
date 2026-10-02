# Sequential campaigns on a shared bundle — design

**Date:** 2026-10-02
**Status:** awaiting review

## Goal

A merchant can schedule a campaign using bundles that another campaign already
holds, provided the two windows do not overlap. November's sale and December's
sale can both be set up today, on the same bundles, and each takes over in turn.

## The problem

A bundle is a single row with one `scheduleStart`/`scheduleEnd` pair and one
`pre_sale_price`. Publish *stamps* those at publish time, so a campaign
published with a December window would immediately overwrite a campaign
currently running in November.

The present code avoids that by refusing the second campaign outright:
`assertBundleAttachable` blocks a bundle whose owner is still locking, at
selection AND at publish. That is correct and too strict — it forbids
simultaneous ownership, which is impossible, and sequential ownership, which is
ordinary.

## Prior art

Shopify's own Launchpad permits sequential events and forbids overlapping ones:

> You cannot run or schedule overlapping events… If you have an event scheduled
> that does not have an end date and you want to start another event after the
> scheduled event, then you must edit the scheduled event and set an end date
> before you create the other event. You also need to schedule your events five
> minutes apart.

Two things in our existing design already match it. We refuse sale pricing
without an end date, for the same reason Launchpad demands one: without an end
there is nothing for a later event to follow. And Launchpad restores a
product's pre-event price when an event ends, which is what `pre_sale_price`
does.

This spec adopts their rule: **many campaigns per bundle, no two overlapping.**

## The handover hazard, and why nothing needs building for it

Launchpad's five-minute gap exists because back-to-back sales on one product
are dangerous. If campaign B applies before campaign A has restored, B captures
**A's sale price** as the original, and the merchant's real price is gone.

Our existing guard already prevents this: `decideSaleAction` returns `none`
whenever `pre_sale_price` is non-null, so B cannot apply while A's capture is
outstanding. B waits a pass, A restores and clears the capture, and B then
captures the true original.

**The cost is that B's sale may start up to one cron pass (five minutes) late.
That is the correct trade and must not be "optimised" away** — the alternative
is losing a merchant's real price, permanently, which is the failure the whole
capture mechanism exists to prevent.

This spec therefore does **not** enforce a gap between campaigns. A merchant
may set back-to-back windows; the guard makes them safe, merely late. Refusing
the dates would be stricter than the risk warrants.

## The change: ownership is derived, not stamped

Everything else in this feature is derived — campaign status from its window,
the ownership lock from that status, the sale state from `pre_sale_price`.
Bundle ownership is the one thing still written days ahead and trusted
afterwards, and that is precisely what makes a second campaign impossible.

So each cron pass resolves, per bundle, **which campaign's window contains now**
rather than reading a stamp. A queue of campaigns on one bundle stops being a
special case.

| Layer | Today | After |
|---|---|---|
| Selection | refused when another campaign locks the bundle | allowed; a Draft writes nothing, so there is nothing to conflict with. The badge becomes informational |
| Publish | stamps the bundle unconditionally | refuses on a genuine window overlap; stamps only when this campaign's window is the current one |
| Cron | reads `bundle.campaignId` | resolves the owner from campaign windows, and hands the bundle on when one ends |
| Restore | unchanged | unchanged |

## Publish validation

Refuse when this campaign's window overlaps that of another `Scheduled` or
`Published` campaign sharing at least one bundle. Two windows overlap when
`aStart < bEnd && bStart < aEnd`; a null end is treated as "runs forever" and
therefore overlaps everything after its start — which is consistent with the
existing rule that a sale needs an end date.

The error names **both** the clashing campaign and the bundle, because a
merchant with several campaigns cannot otherwise tell which pair to fix:

> "Weekend Away Set is already in \"BFCM Sale\" (Published), whose window
> overlaps this one. Change this campaign's dates, or remove that bundle."

Refused at publish, not when the dates are typed. A Draft is a working document
and may legitimately be half-built; the publish gate is where the app already
refuses everything else it cannot honour.

## What must keep working

These are existing guarantees that the ownership change touches, and the
implementation is not finished until each still holds:

- **A bundle holding a capture always restores**, even when no campaign claims
  it. That is the scanner's third query, and it is what makes a deleted or
  detached campaign safe. Ownership becoming derived must not make a bundle
  unreachable.
- **`saleLive` keeps its `campaignId !== null` gate.** A standalone scheduled
  bundle still gets composition-metafield-only behaviour and no repricing.
- **Capture before the Shopify write, restore before clearing.** Untouched.
- **One campaign cannot overwrite another's live window.** This is the point of
  the overlap check; it replaces the ownership stamp as the mechanism.

`assertBundleAttachable` is called from two places today (the campaign `PUT`
and publish). To be unambiguous about which survives:

- **The `PUT` call is removed.** It is what blocks selection, and a Draft
  listing a bundle writes nothing to that bundle.
- **The publish call stays**, unchanged, as the last line of defence: the
  overlap check runs against windows as they were a moment earlier, and this
  catches a bundle whose owner became current in between. Belt and braces on
  the only path that writes.

## Scope

**In:** several campaigns per bundle with non-overlapping windows; overlap
refused at publish; bundle selection no longer blocked by another campaign;
ownership resolved per pass.

**Out:** a mandated gap between campaigns; overlap warnings on the Schedule
step as dates are typed; any change to how discounts work — those are already
fully concurrent and need no ownership at all.

## Open question for review

Ownership being derived means `bundle.campaign_id` stops being the source of
truth and becomes a cache of the current owner. The alternative is to keep it
authoritative and have publish write a queue onto `campaign_bundle` instead.

Deriving is recommended because it matches every other decision in this feature
and cannot go stale. The cost is that the cron does slightly more work per pass,
and that `bundle.campaign_id` means something subtly different from today —
"who owns it now" rather than "who published it". That rename is worth doing
explicitly in the implementation rather than leaving the old name to mislead.
