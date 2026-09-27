# E5 — Promotion templates (implementation design)

**Date:** 2026-09-27
**Epic:** E5 — Promotion templates
**Issue:** [#7](https://github.com/hassan-qureshi1/discountjet/issues/7)
**Supersedes:** `2026-08-25-e05-promotion-templates-design.md` §5 on two points — see §3.
**Shopify plan:** All. The three discount **functions** are All-plans; only Cart Transform is Plus-only, and it is out of scope (§10).

---

## 1. Summary

A merchant browses a gallery of plain-language promotions — "Buy more, save more",
"Percentage off", "Buy X get Y" — clicks one, lands on a create page already shaped for that
promotion, fills in the numbers and products, and presses Create. The app writes the discount and
its function configuration to Shopify in a single mutation.

Templates are stored in D1 keyed by `slug`, so the create page is rendered from stored data
rather than hard-coded per template.

Creating is engine-agnostic: one route dispatches through a **`DiscountEngineAdapter`** to whichever
of the three discount functions the template targets. Adding a fourth engine is one adapter and one
registry entry, not a new route.

## 2. What already exists

This matters, because the 2026-08-25 spec was written against assumptions that no longer hold.

- **Authoring (E3) is built as Shopify-native UI extensions**, not an app-side wizard. Each of
  `extensions/discount-{tier,bundle,special}-ui` targets
  `admin.discount-details.function-settings.render` and renders inside Shopify's own discount page.
  There is no app-side create path, and there never was one to "hand off" to.
- **The engine contracts are pinned and pure.** Each `extensions/discount-*-ui/src/config.ts` is
  dependency-free and documented as emitting "exactly the snake_case JSON the Rust serde contract
  parses":

  | handle | Shopify name | namespace | key | `rule_type` |
  |---|---|---|---|---|
  | `discount-tier` | Volume Discount | `$app:discount-tier` | `config` | `tier-discount` |
  | `discount-bundle` | Buy X, Get Y | `$app:discount-bundle` | `config` | `bundle-discount` |
  | `discount-special` | Buy X Discount Both | `$app:discount-special` | `config` | `special_discount` |

  `special_discount` uses an underscore where the others use a hyphen. That is the Rust contract and
  is NOT changed here; the adapter is where that inconsistency stops leaking into callers.
- **All three modules already expose the same interface**, arrived at independently:
  `build<X>Config`, `validate<X>Config`, `getMetafieldValueString`, `getMetafieldSizeBytes`,
  `validateMetafieldSize`, `parseMetafield`, and identical `SelectorType` / `ApplyTo` /
  `SelectionStrategy` / `Platform` primitives. §4 names that interface.
- **The discount read path exists** — `GET /api/discounts`, `GET /api/discounts/:id`, the
  `discounts/*` webhooks and the `discount` mirror table, whose `type` enum is already
  `['tier','bundle','special']`.
- **`resolveCartTransformFunctionId`** (`src/lib/cartTransformRegistration.ts`) is the working
  pattern for turning a function into a `functionId` at runtime.

## 3. Decisions that supersede the 2026-08-25 spec

| Topic | 2026-08-25 said | This spec |
|---|---|---|
| Registry location | Static JSON shipped with the frontend; "no new table, no migration, no API route for E5" | **A global `template` table in D1**, keyed by `slug`, read over an API |
| Create flow | Prefill E3's app-side wizard | **App-side create route** calling `discountAutomaticAppCreate`, because E3 is a Shopify-native extension |

Both changes were requested directly and are recorded here so the divergence is deliberate rather
than accidental.

## 4. The `DiscountEngineAdapter`

The heart of "dynamic". One interface, three implementations, one registry.

```ts
export interface DiscountEngineAdapter<TForm> {
  type: 'tier' | 'bundle' | 'special';
  /** Extension handle, used to resolve the runtime functionId. */
  functionHandle: string;
  /** `$app:` metafield the Rust function reads. */
  namespace: string;
  key: 'config';

  validate(form: TForm): string[];
  serialize(form: TForm): string;
  sizeBytes(form: TForm): number;
  parse(value?: string): TForm;
}
```

Backed by the existing pure functions — `validate` is `validate<X>Config`, `serialize` is
`getMetafieldValueString`, and so on. The adapter adds no logic; it names a shape the three modules
already have.

`ENGINE_ADAPTERS: Record<DiscountEngineType, DiscountEngineAdapter<never>>` is the single dispatch
point. The create route never branches on type.

### 4.1 Where the engine modules live

**Moved to `src/lib/discountEngines/{tier,bundle,special}.ts`, with the extensions importing from
there.** One copy, so drift is impossible rather than merely discouraged.

The failure this prevents is silent and expensive: two copies drift, the app writes configuration the
Rust function misreads, and a real discount misprices at checkout with nothing erroring.

The modules are pure and import nothing, so the move is mechanical. `tsconfig.json` covers
`src/**` already; `extensions/**` is outside it and each extension builds with its own bundler, so
**the extension build must be verified** (`shopify app build`) as part of this task.

**Fallback if an extension build refuses an import above its root:** `src/lib/discountEngines/`
holds the source of truth, the extension keeps its copy, and a **contract test** runs both against
shared fixtures and fails on any divergence. Worse than one copy, but it turns a silent checkout bug
into a red build. This fallback is a decision point during implementation, not a licence to skip the
attempt.

## 5. Data model

### 5.1 `template` — global, no `shopId`

Curated editorial content: identical for every shop, carrying no tenant data, with nothing to cascade
on `SHOP_REDACT`. It is therefore the second documented exception to the project's tenant rule, after
`webhook_event`, and carries that justification **at the table definition**.

| column | type | note |
|---|---|---|
| `id` | `text` PK | `crypto.randomUUID()`, per the project rule |
| `slug` | `text` NOT NULL | **unique** — the route key for `/templates/:slug` |
| `name` | `text` NOT NULL | merchant-facing |
| `description` | `text` NOT NULL | merchant-facing |
| `example` | `text` | e.g. "Buy 3, get 20% off" |
| `category` | `text` NOT NULL | drives gallery filters; merchant intent, never the engine name |
| `symbol` | `text` | tile glyph |
| `type` | `text` NOT NULL | `'tier' \| 'bundle' \| 'special'` — the engine; never shown to the merchant |
| `defaults` | `text` NOT NULL | JSON: the partial form data this template prefills |
| `sort_order` | `integer` NOT NULL default 0 | gallery order without renaming |
| `active` | `integer` NOT NULL default 1 | 0/1; hide without deleting |
| `created_at` | `text` NOT NULL | ISO 8601 |
| `updated_at` | `text` NOT NULL | ISO 8601 |

Indexes: `template_slug_unq` unique on `slug`; `template_active_sort_idx` on `(active, sort_order)`.

`id` stays a UUID with `slug` as a unique index rather than making the slug the primary key — the
"all IDs are `crypto.randomUUID()`" rule holds, and the slug does the routing.

`docs/erd.dbml` is updated in the same commit as the `schema.ts` edit and the generated migration.

### 5.2 `TemplateRepository`

Outside the `ShopScopedRepository` hierarchy, like `WebhookEventRepository`, with the reason stated
at the class: there is no `shopId` to scope by, and extending the scoped base would advertise a
guarantee this table does not have.

```ts
listActive(): Promise<TemplateRow[]>          // active = 1, ordered by sort_order then name
findBySlug(slug: string): Promise<TemplateRow | null>
upsertMany(defs: TemplateSeed[]): Promise<void>   // idempotent, keyed by slug
```

Registered via its own factory (`createTemplateRepository(d1)`), **not** added to `Repositories` —
nothing built per-request needs it scoped, and it has no tenant.

### 5.3 Seeding

An idempotent upsert by `slug` from a code-side catalogue (`src/lib/templates/catalogue.ts`), run
from the install lifecycle. Not a migration: changing copy would otherwise mean shipping one.
Re-running is a no-op, and a store installing later gets the current set.

**Known trade-off, stated plainly:** the catalogue still lives in code today, so D1 mirrors it and
nothing is editable without a deploy. What this buys now is that the read path is already DB-backed,
so adding an admin editor later touches no page code.

## 6. API

Both routes behind the existing `requireShop` middleware.

### 6.1 Reads

- `GET /api/templates` → `{ templates: TemplateDto[] }`, active only, ordered.
- `GET /api/templates/:slug` → `{ template: TemplateDto }`, `404` when absent or inactive.

`TemplateDto` exposes `defaults` as parsed JSON, not a string — the client should not re-parse what
the server already validated.

### 6.2 `POST /api/discounts`

Takes the merchant's **form data**, never a pre-built config. A client that could hand us a finished
config could hand us any config, and this one lands on a real shopper's bill.

```
{ slug, title, startsAt, endsAt?, combinesWith?, form: <per-engine form data> }
```

Handler order:

1. `templates.findBySlug(slug)` → `404` if absent. The template decides the engine; the client does
   not get to name it.
2. `adapter = ENGINE_ADAPTERS[template.type]`.
3. `adapter.validate(form)` → `400` with the message list when non-empty.
4. `adapter.serialize(form)`; `adapter.sizeBytes(form)` against the 10 KB ceiling → `400` when over.
   That ceiling is Shopify's, and the existing UI has a size meter for it.
5. Resolve `functionId` from `adapter.functionHandle` against `shopifyFunctions`, mirroring
   `resolveCartTransformFunctionId`. **Resolved fresh on every create, never cached** — caching a
   Shopify id without verifying it is exactly the bug fixed in `21a0d3a`, where a stale
   `cartTransformGid` left the app permanently believing it was registered.
6. `discountAutomaticAppCreate` with `title`, `functionId`, `startsAt`/`endsAt`, `combinesWith`, and
   `metafields: [{ namespace: adapter.namespace, key: 'config', type: 'json', value }]` — one
   mutation creates the discount **and** its configuration.
7. Non-empty `userErrors` → throw, surfaced as `502` with the messages. Never swallowed.

**`functionId`, not `functionHandle`:** the Worker's Admin client pins `2026-04`
(`src/lib/graphqlAdmin.ts`), where `DiscountAutomaticAppInput` requires `functionId`.

**No D1 write.** Shopify is the source of truth for discounts and the existing `discounts/create`
webhook already mirrors into the `discount` table. Inserting here would race the webhook.

**Automatic discounts only in v1.** `discountCodeAppCreate` is a near-identical sibling to add when a
template needs a code; none does yet.

## 7. UI

### 7.1 Gallery — `web/Pages/Templates.tsx` at `/templates`

`Page` titled "Promotion templates" with the jargon-free subtitle, a filter row **derived from the
distinct `category` values returned by the API** (so a new template never requires editing the
gallery), and an `InlineGrid` of cards. Spinner while loading, Polaris `Banner` on error.

`web/components/TemplateCard.tsx` — generic: tile, name, description, example chip, category badge,
and an `onAction`. It takes content, not a discount, so it is not discount-specific. Reuses the
existing `SymbolTile`.

### 7.2 Create — `web/Pages/TemplateCreate.tsx` at `/templates/:slug`

Shared chrome for every engine: title, schedule, combinations, the size meter, error banner, and
submit. The **form body is chosen by `template.type`** and seeded from `template.defaults`:

| type | body | shape |
|---|---|---|
| `tier` | tier rows | `TierFormData { message, applyTo, discountType, productDiscountSelectionStrategy, platform, tiers[] }` |
| `bundle` | X/Y rows | `BundleFormData { platform, bundles[] }` |
| `special` | source + target groups | `SpecialFormData { platform, specials[] }` |

Each body is its own component under `web/templates/forms/`, so the page stays a layout.

On success → navigate to the existing `/discounts`. No new list page is built; that surface already
exists.

### 7.3 Reuse

- `web/bundles/picker.ts` (`flattenPickerSelection`, `selectionIdsFromVariants`) is about Shopify's
  resource picker, not bundles. **Moved to `web/lib/picker.ts`** and used by the tier/bundle/special
  target fields.
- `web/components/VariantLabel` renders a picked variant with its deleted/unresolved states.
- `web/components/PriceCard`, `ScheduleCard` reused where the shape fits.

### 7.4 Wiring

Two routes in `web/App.tsx` plus a `Templates` link in `NavMenu`. Client calls in
`web/templates/api.ts` and `web/templates/hooks.ts`, matching the `web/bundles/` pattern.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| Unknown or inactive slug | `404` |
| `validate()` non-empty | `400` with the message list |
| Config over 10 KB | `400` naming the limit |
| Function not deployed on the shop | `502`, message names the missing function |
| `userErrors` from Shopify | `502` with the messages, never swallowed |
| Shopify unreachable | `502`; nothing partial is persisted, because nothing is persisted at all |

No fallbacks mask a missing function id, domain, or token — consistent with the root `CLAUDE.md`.

## 9. Testing

**Unit — adapters.** Each adapter serialises a known form to the exact JSON its Rust contract
expects, including `rule_type` (`tier-discount`, `bundle-discount`, `special_discount`), and
`validate` rejects the cases `validate<X>Config` already encodes.

**Contract — engine modules.** If the shared-module move succeeds, this is covered by there being one
copy. If the fallback is taken, a test runs both copies over shared fixtures and fails on divergence.

**Repository — `TemplateRepository`.** Against the recording fake D1: `findBySlug` binds the slug,
`listActive` filters on `active = 1` and orders, `upsertMany` is idempotent.

**Route — `POST /api/discounts`.** Unknown slug → 404. Invalid form → 400, nothing sent to Shopify.
Oversized config → 400. Happy path → one `discountAutomaticAppCreate` carrying the right
`functionId`, namespace and serialised value. `userErrors` → 502. Client-supplied `type` is ignored
in favour of the template's.

**Route — templates.** `GET /api/templates` returns only active rows; `GET /api/templates/:slug`
404s on an inactive one.

## 10. Out of scope

- **Cart Transform bundles (E6).** Not a discount: a `cartTransformGid` plus the `bundle` table,
  with its own editor and a Plus-only gate. A template resolving to Cart Transform routes to
  `/bundles/new` rather than through this create route.
- `discountCodeAppCreate` (code discounts) — §6.2.
- E11 active-discount limits; not built.
- Merchant-editable or admin-editable templates — §5.3 records what would be needed.
- Editing an existing discount. That happens in Shopify's own discount page via the existing UI
  extensions, which read the same metafield this route writes.

## 11. Suggested staging

The adapter layer makes all three engines cheap on the **backend** — one route, three thin adapters.
The expensive part is the three form bodies (§7.2): `special` alone has nested target groups with
per-group operator, value and message.

A plan can therefore ship in two stages without redesigning anything:

1. **Foundation + tier.** Engine modules moved and shared, all three adapters, the `template` table,
   repository, seeding, both read routes, `POST /api/discounts`, gallery, create page shell, and the
   tier form body. The `bundle` and `special` adapters are exercised by unit tests even before their
   forms exist, so the dispatch is proven, not assumed.
2. **Bundle and special form bodies.** Purely additive: two components and their template catalogue
   entries. No route, schema or adapter changes.

Stage 1 is a working feature — three tier templates a merchant can use end to end. Stage 2 widens it.
Splitting the other way (all three forms, no backend) would ship nothing usable.
