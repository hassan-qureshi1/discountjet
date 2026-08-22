# Discount Engine — UI

A **standalone** Shopify Polaris admin UI for the Discount Engine app. Everything
is **hardcoded** — no backend, no Shopify App Bridge, no auth. Data lives in JSON
fixtures, is loaded into a Zustand store, and read from there by the pages.

```bash
cd discount-engine-ui
npm install
npm run dev        # → http://localhost:5173
```

Other scripts: `npm run build` (typecheck + production build), `npm run preview`,
`npm run typecheck`.

## Sections

| Route | Page |
|---|---|
| `/` | **Overview** — plan banner, KPI stats, recent activity, cart-transform schedule |
| `/templates` | **Templates** — filterable gallery of promotion templates |
| `/campaigns` | **Campaigns** — status tabs + campaign table with revenue/orders |
| `/discounts` | **Discounts** — type/status tabs + synced-discount table |
| `/cart-transforms` | **Cart transforms** — scheduled bundle campaigns + metafield state |
| `/plan` | **Plan & limits** — current plan usage meter + tier table |

### Create / edit / detail flows

| Route | Page |
|---|---|
| `/templates/:id/create` | Create promotion from a template |
| `/discounts/new` | Create-discount wizard (4-step function setup) |
| `/discounts/:id` | Discount detail (synced config + upsell) |
| `/discounts/:id/upsell` | Upsell card designer with **live preview** |
| `/cart-transforms/new` · `/cart-transforms/:id/edit` | Cart-transform campaign editor (bundles + schedule) |
| `/campaigns/templates` | Campaign template gallery |
| `/campaigns/new` · `/campaigns/:id/edit` | Campaign builder (5-step wizard) |
| `/campaigns/:id` | Campaign detail (published/locked, with metrics) |

Every list screen's actions are wired: **Create**, **View config / View**, **Edit**, **Clone**, **Use template**, **Browse templates**.

## How the data flows

```
src/data/*.json  →  src/store/useDiscountStore.ts (Zustand)  →  pages read via selector hooks
```

Swap the JSON imports in `useDiscountStore.ts` for real API calls to wire this up
to a backend later — the pages don't change.

## Structure

```
src/
  data/           Hardcoded JSON fixtures (one file per domain)
  types/          TypeScript interfaces for every entity
  store/          Zustand store + selector hooks
  components/
    layout/       AppFrame (Polaris Frame/TopBar/Navigation), nav config, router link
    common/       StatCard, StatusBadge, SymbolTile, TemplateCard, SectionHeader
  pages/          One component per section
  App.tsx         Routes, wrapped in the app frame
  main.tsx        AppProvider + Polaris CSS + Router
```

## Stack

React 18 · TypeScript · Vite · Shopify Polaris 13 · React Router 6 · Zustand 4.

> **Note:** if `localhost:5173` shows a blank page or a different app's title, an old
> service worker from a previous project on that port is intercepting it. Open
> DevTools → Application → Service Workers → Unregister, then hard-reload.
