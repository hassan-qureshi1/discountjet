# E10 — Storefront upsell widget

**Date:** 2026-08-25
**Status:** Design — ready to plan
**Epic:** E10 — Storefront upsell widget
**Shopify plan (SP):** All plans (Basic / Shopify / Advanced / Plus)
**Depends on:** E3 (Discount authoring — owns the `discount` + `discount_config` records and the product/pricing the upsell renders)
**Related:** E1 (Worker foundations, `getShopAccessToken`, D1 + Drizzle), E9 (campaign scheduling — upsell visibility follows discount activation)
**Issues:** E10-1 … E10-4 (decomposition §7)

---

## Summary

A storefront upsell widget that surfaces a discount's products to shoppers on the live
storefront, plus the in-admin designer that configures its content, layout, and placement with a
live preview. The storefront surface is delivered as a **Shopify theme app extension** (an app
embed block that boots the widget, plus an app block merchants can drop into the theme editor),
rendered on the **product page (PDP)**, the **cart page and cart drawer**, and an optional
**sticky footer bar**. At runtime the widget fetches its per-discount configuration and the list
of eligible upsell products from a storefront-safe endpoint on the Worker (a Shopify **App
Proxy**). The designer persists the card configuration per discount to D1; the extension reads
exactly that configuration back. Because theme app extensions and App Proxy are available on
every Shopify plan, E10 ships with **no Plus gate**.

The prototype already encodes the design contract: `UpsellDesigner.tsx` is the full control
surface (heading, ATC label, product count, six element toggles, List/Grid layout, accent colour
"auto-detected from Dawn", three placements + PDP position) with a two-view (PDP / Cart) live
preview, and `DiscountDetail.tsx` carries the "Storefront upsell" card and the **Design upsell
card** CTA that routes to `/discounts/:id/upsell`. E10 makes both real: it turns the prototype's
local component state into persisted config and turns the mocked preview into an actual rendered
storefront widget driven by the same config.

---

## Current state

The designer and preview exist as a **fixture-driven prototype**; there is **no storefront
rendering and no persistence** — every control is local React state that is discarded on
navigation, and the "Save & publish" / "Reset" buttons have no handlers.

- **`discount-engine-ui/src/pages/UpsellDesigner.tsx`** — the designer page mounted at
  `/discounts/:id/upsell`. All controls are `useState`:
  - Content: `heading` (default `"Complete your bedroom"`), `btnLabel` (ATC label, default
    `"Add"`), `productCount` (`Select` of `2 / 3 / 4 / 6 products`).
  - `elements` object with six booleans — `image`, `title`, `price`, `strike` (crossed-out
    original), `save` (savings badge), `atc` (add-to-cart button).
  - Layout: `layout` (`0` List / `1` Grid) via `SegmentedControl`.
  - `accent` colour from a hardcoded `SWATCHES` array `['#008060','#1a1a1a','#b45309','#4b6bfb']`,
    labelled *"Accent colour — ✨ auto-detected from your theme (Dawn)"* — the auto-detection is
    **copy only**, not implemented.
  - Placement: three `Checkbox`es (Product page, Cart & drawer, Sticky footer bar) that are
    **static** (`onChange={() => undefined}`), plus a static `Select` "Position on PDP"
    (`Below add-to-cart` / `Above description` / `After image gallery`).
  - Live preview (right column, sticky): a fake browser chrome with a `PDP / Cart` toggle
    (`preview` state) that re-renders a hardcoded `PRODUCTS` array honouring the `elements`,
    `layout`, and `accent` state. Prices/emoji are literals in the file.
- **`discount-engine-ui/src/pages/DiscountDetail.tsx`** — the discount detail page hosts the
  **"Storefront upsell"** card (`Badge tone="success">Shown`), gates the **Design upsell card**
  primary button on `locked` (campaign-owned discounts can't edit their own upsell), routes to
  `/discounts/${discount.id}/upsell`, and shows an **"Upsell preview"** card with a single mocked
  product row and the note *"Strike price is derived from this discount's config."*
- **Backend / extensions:** none. `src/db/schema.ts` ships only `shopify_shop`. There is **no
  `extensions/` directory**, no theme app extension, no App Proxy route, and no upsell config
  table. `src/index.ts` wires `requireShop` over all `/api/*`; `PUBLIC_API_PATHS` in
  `src/middleware/requireShop.ts` is empty. The storefront endpoint E10 needs does not yet exist.

E10 depends on E3 for the `discount` / `discount_config` records: the upsell renders the same
products and the same discounted vs. original (strike) pricing the discount function config
already describes. E10 stores only the **presentation** config on top of that.

---

## Shopify plan gating

**All plans. No Plus gate.**

Per the decomposition capability matrix (§3): *"Storefront upsell widget (theme app extension) —
✅ Basic / ✅ Shopify / ✅ Advanced / ✅ Plus — Theme app extensions, all plans."* Both platform
primitives E10 relies on are unrestricted:

- **Theme app extensions** (app embed blocks + app blocks) are supported on every Online Store
  2.0 theme regardless of the merchant's Shopify plan.
- **App Proxy** (the storefront-safe, HMAC-signed request path from `{shop}/apps/...` to the
  app) is available on all plans.

Unlike E6/E7 (Cart Transform, Plus-only), E10 renders in the theme and adds items via the
storefront cart AJAX API — it does **not** use any Function or Cart Transform operation — so
there is nothing to gate. The designer and widget must therefore **never** show a plan-upgrade
prompt. The only visibility rule is the discount's own state (active/scheduled) and the
campaign-lock rule inherited from `DiscountDetail.tsx` (campaign-owned discounts have their
upsell managed by the campaign, not edited standalone).

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────────┐
│ Admin (embedded app)                                                  │
│   UpsellDesigner.tsx  ──save──▶  POST /api/discounts/:id/upsell  ──┐  │
│   (per-discount config, live preview)                              │  │
└────────────────────────────────────────────────────────────────────┼──┘
                                                                      │
                                             D1: upsell_config (per discount, shopId FK)
                                                                      │
┌─────────────────────────────────────────────────────────────────────┼──┐
│ Storefront (theme app extension)                                     │  │
│   app embed block: dj-upsell.liquid  (boots widget, injects config    │  │
│                     surface anchor + JS/CSS)                          │  │
│   app block:        dj-upsell-block.liquid (merchant-placed section)   │  │
│                                    │                                  │  │
│              fetch (App Proxy, HMAC-verified) ─────────────────────┐  │  │
│              GET /apps/discount-jet/upsell?product_id=…&view=pdp   │  │  │
└────────────────────────────────────────────────────────────────────┼──┼──┘
                                                                      │  │
              src/routes/app-proxy.ts  (PUBLIC_API_PATHS, HMAC verify)◀┘  │
                 → reads upsell_config + discount + discount_config ◀──────┘
                 → returns { config, products[] } as JSON
```

### Theme app extension (E10-1, E10-2)

A single theme app extension (`extensions/theme-app-extension/`) ships two block types:

- **App embed block** (`blocks/dj-upsell.liquid`, `target: body`) — enabled once by the merchant
  in the theme editor's *App embeds* tray. It injects the widget's JS + CSS (theme-extension
  static `assets/`) and a small bootstrap config (shop domain, App Proxy base path, current
  `product.id` / template via Liquid globals). It is responsible for the **PDP inline placement**
  (positioned per the config's PDP position), the **cart & drawer** placement (mount into the
  cart section, and re-mount on cart-drawer open events), and the **sticky footer** placement
  (a fixed bar). Placement targets that are toggled off in config render nothing.
- **App block** (`blocks/dj-upsell-block.liquid`, section target) — a merchant-draggable block
  for themes/sections where the merchant wants explicit control over position (e.g. drop it into
  the product template exactly where they want the card). Same widget code, mounted at the block
  location instead of an auto-detected anchor.

The widget is **vanilla JS + CSS** (no framework runtime shipped to the storefront) to keep the
storefront payload small. It renders the card DOM from the fetched config, mirroring the
prototype preview's structure (product row/grid, image/title/price/strike/savings/ATC per the
element toggles, accent applied to the ATC button). Add-to-cart uses the storefront **Cart AJAX
API** (`POST {routes.cart_add_url}`) — the discount itself is applied by the E2 discount function
at checkout; the widget only puts the eligible variant in the cart.

### Config + products fetch (App Proxy)

The widget must read data **without an admin session token** (there is none on the storefront),
so E10 adds a **Shopify App Proxy** subpath (configured in `shopify.app.toml`, owned by E1's app
config, e.g. prefix `apps`, subpath `discount-jet`). Storefront requests to
`https://{shop}/apps/discount-jet/upsell?...` are forwarded by Shopify to the Worker with
Shopify-appended query params (`shop`, `path_prefix`, `timestamp`, `signature`).

- **New route `src/routes/app-proxy.ts`**, mounted in `src/index.ts`, path under `/api/` so it
  passes through the Hono app but **added to `PUBLIC_API_PATHS`** in
  `src/middleware/requireShop.ts` with a justifying comment (there is no shop session on the
  storefront; the request is instead authenticated by **App Proxy HMAC verification**). The route
  handler:
  1. Verifies the `signature` query param (HMAC-SHA256 of the sorted query params with the app
     secret) using the constant-time compare in `src/lib/timingSafeEqual.ts`; reject with 401 on
     mismatch. This is the storefront analogue of `requireShop`.
  2. Resolves `shopId` from the verified `shop` domain (lookup in `shopify_shop`).
  3. Looks up the relevant **active** discount(s) for the request context (the `product_id` on
     PDP, or all active upsell discounts for cart/sticky), joining `upsell_config` (presentation)
     + `discount` (status, gid) + `discount_config` (products, discounted vs. compare-at pricing
     from E3). Excludes non-active / expired discounts.
  4. Returns compact JSON: `{ config: {...}, products: [{ variantId, title, image, price,
     compareAt, savingsLabel }] }`, capped to the config's `productCount`.
- Responses are **cache-friendly** (short `Cache-Control`, e.g. 60s, keyed by shop + product +
  view) since config changes are infrequent and storefront traffic is high.

### Persistence (designer → D1)

The designer saves to an authenticated admin route **`POST /api/discounts/:id/upsell`** (guarded
by the existing `requireShop`), which upserts one `upsell_config` row per discount. The extension
never talks to this route; it only reads via the App Proxy. This keeps the write path
session-authenticated and the read path HMAC-authenticated, matching the project's
"secure by default" rule.

### Accent colour "auto-detected from theme"

The prototype's *"auto-detected from Dawn"* label is aspirational. The implemented approach:

- **Storefront-side detection (source of truth):** the app embed block reads the theme's own CSS
  custom properties / button styling at runtime (e.g. the computed accent/`--color-button` or the
  primary button's background on the page) and the widget defaults its ATC button to that value,
  so the card matches the live theme without per-theme configuration. This is what makes the
  claim true on the storefront regardless of theme.
- **Admin default seeding:** on first open of the designer, the accent defaults to a sensible
  value (the current hardcoded `#008060` swatch stands in). If the theme's detected accent is
  available (e.g. surfaced via a one-time storefront probe cached on the shop), the designer
  pre-selects it; otherwise the merchant picks from the swatches / an override.
- **Override:** whatever accent the merchant explicitly picks in the designer is stored in
  `upsell_config.accent` and **wins** over auto-detection. `accent: "auto"` (a sentinel) means
  "use theme-detected"; a hex value means "use this".

The prototype's fixed `SWATCHES` become preset choices plus the `"auto"` option; the label copy
stays honest because detection is genuinely performed on the storefront.

---

## Config model

One row per discount in **`upsell_config`** (D1, Drizzle). Every field maps to a control in
`UpsellDesigner.tsx`. Shared conventions (decomposition §5): `id = crypto.randomUUID()`,
timestamps ISO 8601 `text()`, non-null `shopId text` FK → `shopify_shop.id`
`onDelete: 'cascade'`.

| Field | Type | Prototype control | Notes |
|---|---|---|---|
| `id` | text PK | — | `crypto.randomUUID()`. |
| `shopId` | text, not null, FK→`shopify_shop.id` cascade | — | Multi-tenancy / SHOP_REDACT. |
| `discountId` | text, not null, FK→`discount.id` cascade, **unique** | route `:id` | One upsell config per discount. |
| `heading` | text | `heading` TextField | Section heading, default `"Complete your bedroom"`. |
| `atcLabel` | text | `btnLabel` TextField | Add-to-cart button label, default `"Add"`. |
| `productCount` | integer | `productCount` Select | One of `2 / 3 / 4 / 6`; caps products returned by the proxy. |
| `showImage` | integer (bool) | `elements.image` | Element toggle. |
| `showTitle` | integer (bool) | `elements.title` | Element toggle. |
| `showPrice` | integer (bool) | `elements.price` | Discounted price. |
| `showStrike` | integer (bool) | `elements.strike` | Crossed-out original/compare-at price. |
| `showSavings` | integer (bool) | `elements.save` | Savings badge. |
| `showAtc` | integer (bool) | `elements.atc` | Add-to-cart button. |
| `layout` | text enum `list` \| `grid` | `layout` (0/1) SegmentedControl | Default `list`. |
| `accent` | text | `accent` swatches | Hex (`#008060`) or sentinel `"auto"` (theme-detected). Default `"auto"`. |
| `placePdp` | integer (bool) | Placement "Product page" checkbox | Default true. |
| `placeCart` | integer (bool) | Placement "Cart & drawer" checkbox | Default true. |
| `placeSticky` | integer (bool) | Placement "Sticky footer bar" checkbox | Default false. |
| `pdpPosition` | text enum | "Position on PDP" Select | `below_atc` \| `above_description` \| `after_gallery`. Default `below_atc`. |
| `createdAt` | text | — | ISO 8601. |
| `updatedAt` | text | — | ISO 8601. |

**Not stored here** (derived from E3 at read time, never duplicated): the product list, the
discounted price, and the compare-at/strike price. These come from `discount_config` /
`discount` so the upsell can never drift from the discount. The proxy composes presentation
(`upsell_config`) + data (`discount_config`) into the response. Per the "fail loudly" rule, a
missing discount or missing pricing is an error, not a `?? ''` fallback — the widget renders
nothing rather than a blank/zero price.

---

## Issue breakdown

### E10-1 — Theme app extension scaffold (app embed / app block)

**What.** Create the theme app extension package and register it with the app. Ship an **app
embed block** (boots the widget site-wide, injects assets + bootstrap config) and an **app
block** (merchant-placeable). No live data yet — scaffold renders a placeholder card from static
values to prove the extension loads, has assets served, and reads Liquid globals
(`shop`, `product`, `template`, `routes.cart_add_url`).

**Acceptance criteria.**
- `extensions/theme-app-extension/shopify.extension.toml` defines the extension; `shopify app
  dev` serves it into a dev theme.
- App embed block appears under *Theme editor → App embeds* and, when enabled, injects the
  widget JS/CSS and a bootstrap `<script type="application/json">` with shop domain + proxy base
  path + current product id/template.
- App block appears in the theme editor's *Add block* picker for product/cart sections and mounts
  at its drop location.
- Assets (`assets/dj-upsell.js`, `assets/dj-upsell.css`) load from the extension's static assets,
  not an external host.
- Placeholder card renders on PDP in the dev theme with no console errors.

**Files touched.**
- `extensions/theme-app-extension/shopify.extension.toml`
- `extensions/theme-app-extension/blocks/dj-upsell.liquid` (app embed, `target: body`)
- `extensions/theme-app-extension/blocks/dj-upsell-block.liquid` (app block)
- `extensions/theme-app-extension/assets/dj-upsell.js`
- `extensions/theme-app-extension/assets/dj-upsell.css`
- `extensions/theme-app-extension/locales/en.default.json` (block labels)
- `shopify.app.toml` (declare the App Proxy: prefix `apps`, subpath `discount-jet`) — E1-owned
  file, extended here.

### E10-2 — Storefront widget rendering (PDP / cart & drawer / sticky footer) + App Proxy read

**What.** Make the widget real: fetch config + eligible products from the App Proxy and render
the card on the three placements honouring every config field. Add the storefront-safe proxy
endpoint on the Worker.

**Acceptance criteria.**
- New route `src/routes/app-proxy.ts` handles `GET /apps/discount-jet/upsell` (as forwarded),
  **verifies the App Proxy `signature` HMAC** (constant-time via `src/lib/timingSafeEqual.ts`),
  resolves `shopId` from the verified `shop`, and returns `{ config, products[] }` composed from
  `upsell_config` + `discount` + `discount_config`, capped to `productCount`. Invalid/absent
  signature → 401. Only **active** discounts contribute products.
- Route path added to `PUBLIC_API_PATHS` in `src/middleware/requireShop.ts` with a comment
  justifying it (storefront request, no shop session; authenticated by App Proxy HMAC instead).
- Widget renders: image/title/price/strike/savings/ATC each shown only when the matching toggle
  is true; `layout` list vs. grid; accent applied to the ATC button (hex, or theme-detected when
  `accent = "auto"`); heading + ATC label from config.
- Placement: renders inline on PDP at `pdpPosition` when `placePdp`; renders in cart page and
  **re-renders on cart-drawer open** when `placeCart`; renders a fixed **sticky footer** bar when
  `placeSticky`. Toggled-off placements render nothing.
- ATC adds the correct variant via the Cart AJAX API; the discount applies at checkout via the
  E2 function (not re-implemented here).
- No layout shift / no console errors on Dawn; response is cached briefly.

**Files touched.**
- `src/routes/app-proxy.ts` (new)
- `src/index.ts` (mount the proxy route)
- `src/middleware/requireShop.ts` (`PUBLIC_API_PATHS` entry + justification)
- `src/lib/` (App Proxy HMAC verify helper, reusing `timingSafeEqual.ts`)
- `extensions/theme-app-extension/assets/dj-upsell.js` (fetch + render + placements + ATC)
- `extensions/theme-app-extension/assets/dj-upsell.css` (card, list/grid, sticky bar styles)
- `extensions/theme-app-extension/blocks/dj-upsell.liquid` (placement anchors, drawer hooks)

### E10-3 — Upsell Designer UI + config persistence

**What.** Replace the prototype's local state with a persisted per-discount config. Wire
`UpsellDesigner.tsx` to load an existing config on open and save on "Save & publish"; make the
placement checkboxes and PDP-position select functional; implement the accent `"auto"` option.

**Acceptance criteria.**
- New admin routes: `GET /api/discounts/:id/upsell` (load config, or defaults if none) and
  `POST /api/discounts/:id/upsell` (upsert `upsell_config`), both guarded by `requireShop` and
  scoped to `c.get('shopId')`.
- `upsell_config` table added to `src/db/schema.ts` + Drizzle migration (`npm run d1:generate`).
- Designer loads persisted values into all controls; **"Save & publish"** writes them and shows a
  success toast; **"Reset"** reverts to the last saved (or default) values.
- Placement checkboxes (`placePdp`, `placeCart`, `placeSticky`) and "Position on PDP"
  (`pdpPosition`) become **controlled + persisted** (currently `onChange={() => undefined}`).
- Accent supports the `"auto"` sentinel plus the swatches; the honest "auto-detected from your
  theme" behaviour is what the widget applies at render.
- Campaign-owned discounts remain non-editable here (the `locked` gate in `DiscountDetail.tsx`
  disables the CTA); the API rejects writes to a locked discount's upsell.
- Round-trip verified: save in the designer → the E10-2 proxy returns the new values.

**Files touched.**
- `src/db/schema.ts` (`upsell_config` table) + generated migration under `drizzle/`/`migrations/`
- `src/routes/` (new `discount-upsell.ts` admin GET/POST, mounted in `src/index.ts`)
- `discount-engine-ui/src/pages/UpsellDesigner.tsx` (load/save, functional placement + position,
  accent `"auto"`)
- `discount-engine-ui/src/store/useDiscountStore.ts` (or a new selector hook, e.g.
  `useUpsellConfig`, following the fixture-swap pattern from §5)
- `discount-engine-ui/src/pages/DiscountDetail.tsx` (surface real saved/enabled state on the
  "Storefront upsell" card instead of the static `Shown` badge; optional)

### E10-4 — Live preview (PDP + cart views)

**What.** Drive the existing designer preview from the same config + real discount products
(from E3) instead of the hardcoded `PRODUCTS` array, keeping the PDP/Cart toggle. Ensure preview
fidelity matches the storefront widget (same element toggles, layout, accent, placement copy).

**Acceptance criteria.**
- Preview renders the discount's actual products/pricing (title, discounted price, strike =
  compare-at, savings) from the discount config, not the literal `PRODUCTS`/prices in the file.
- Preview honours every live control: element toggles, `layout` list/grid, `accent` (including
  `"auto"` shown as the theme-detected colour), heading, ATC label, and `productCount`.
- PDP/Cart toggle reflects the two real placements; when a placement is toggled off, the preview
  communicates it won't show there.
- Preview and the storefront widget render structurally the same card (shared markup/CSS contract
  documented) so "what you see is what ships".

**Files touched.**
- `discount-engine-ui/src/pages/UpsellDesigner.tsx` (preview reads config + real products)
- `discount-engine-ui/src/pages/DiscountDetail.tsx` (the small "Upsell preview" card uses real
  first-product data)
- `discount-engine-ui/src/store/useDiscountStore.ts` (expose discount products/pricing to preview)

---

## Testing

- **Designer round-trip (E10-3):** open `/discounts/:id/upsell`, change heading, ATC label,
  product count, each element toggle, layout, accent, and all placements; Save & publish; reload
  the page and assert every control rehydrates from D1. Assert `POST` upserts one row per
  discount (`discountId` unique) and is scoped to `shopId`. Assert "Reset" reverts to last saved.
  Assert a campaign-locked discount rejects the write and disables the CTA.
- **Proxy contract (E10-2):** unit-test the App Proxy HMAC verification (valid signature passes,
  tampered query → 401) using `timingSafeEqual.ts`. Test that only active discounts contribute
  products, that `productCount` caps the list, and that a missing discount/price fails loudly
  (no `?? ''`). Assert the composed JSON shape `{ config, products[] }`.
- **Extension render in a dev theme (E10-1/E10-2):** run `shopify app dev`, enable the app embed
  on a Dawn dev theme, and verify: card renders on PDP at each `pdpPosition`; renders in the cart
  page and re-renders on cart-drawer open; sticky footer appears only when enabled; each element
  toggle shows/hides the right node; List vs. Grid layout; accent applied to ATC; ATC adds the
  variant via Cart AJAX and the discount is applied at checkout. Assert no console errors and no
  external asset requests (CSP/self-contained).
- **Preview parity (E10-4):** snapshot the designer preview DOM and the storefront widget DOM for
  the same config and diff structurally; assert element toggles/layout/accent produce matching
  markup.
- **Multi-tenant isolation:** two shops with different `upsell_config` for the same product id
  each get only their own config through the proxy.

---

## Risks / open questions

- **App Proxy vs. public config endpoint.** App Proxy is chosen because it is HMAC-authenticated,
  same-origin to the storefront (`{shop}/apps/...` — no CORS, first-party cookies), and available
  on all plans. A bare public `/api` endpoint would need its own CORS + abuse controls and
  couldn't prove the request originated from the shop's storefront. **Open:** confirm App Proxy
  latency/caching is acceptable under storefront load and that the 60s cache key
  (shop + product + view) doesn't stale config changes unacceptably; consider a cache-bust on
  save (E10-3) if merchants expect instant preview-to-live.
- **Theme compatibility beyond Dawn.** The prototype claims "auto-detected from Dawn." App blocks
  need Online Store 2.0 sections; cart-drawer mounting and the ATC selector differ across themes
  (drawer open events, `cart_add_url`, section rendering). **Open:** how far beyond Dawn do we
  commit? Proposal — target OS 2.0 themes generally, degrade gracefully (skip a placement whose
  anchor can't be found rather than break the theme), and document Dawn as the reference theme.
  The accent auto-detection must not read a wrong element on non-Dawn themes — fall back to the
  stored `accent` when detection is ambiguous.
- **Performance on the storefront.** The widget ships to every page (app embed on `body`). Keep
  the JS/CSS small (vanilla, no framework), defer the proxy fetch until the placement is in view
  (or the drawer opens), and avoid layout shift by reserving space. **Open:** confirm the added
  weight and one proxy request stay within an acceptable Core Web Vitals budget on PDP; consider
  lazy-mounting the sticky bar and cart card.
- **Config vs. data split & drift.** `upsell_config` stores only presentation; products/pricing
  come from E3 at read time. This prevents drift but couples E10's proxy to E3's
  `discount_config` shape. **Open:** lock the `discount_config` fields the proxy reads
  (product list, discounted price, compare-at) as a contract in the E3 spec so E10 doesn't break
  on E3 changes.
- **Eligibility semantics.** For the cart/sticky placements, "which discount's upsell shows"
  when multiple active discounts exist is unspecified. **Open:** define selection (e.g. highest
  priority / most recently active / per-product match) — likely deferred to a follow-up, with
  E10 shipping PDP (product-matched) as the primary surface and cart showing the single active
  upsell if exactly one applies.
- **Add-to-cart vs. the discount function.** The widget only adds the variant; the E2 function
  applies the discount at checkout. **Open:** confirm the shopper sees the discounted price in
  cart (it applies at checkout, not necessarily in the mini-cart) and word the widget copy so the
  savings shown are not mistaken for an already-applied cart line discount.
