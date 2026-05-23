# Convert JS/JSX → TS/TSX

**Date:** 2026-05-23
**Status:** Approved

## Goal

Convert all JavaScript and JSX source files in this project to TypeScript and TSX. After the change, `tsc --noEmit` passes for both the Worker (`src/`) and the frontend (`web/`), the Vite build succeeds, and ESLint runs without parser errors.

## Scope

In scope:
- All `.jsx` and `.js` files under `web/`.
- `vite.config.js` at the repo root.
- TypeScript, ESLint, and reference (HTML / docs) configuration needed to support the rename.

Out of scope:
- Anything under `src/` — already TypeScript.
- `commitlint.config.js` — stays JavaScript (most lint tools expect `.js`; converting offers no benefit).
- Splitting `tsconfig.json` into project references for Worker vs. browser code (see "Trade-offs").
- Behavior changes, new features, or refactors beyond what the type system requires.

## File Renames

| Old | New |
|---|---|
| `web/main.jsx` | `web/main.tsx` |
| `web/App.jsx` | `web/App.tsx` |
| `web/Pages/Home.jsx` | `web/Pages/Home.tsx` |
| `web/bugsnag.jsx` | `web/bugsnag.tsx` |
| `web/api.js` | `web/api.ts` |
| `vite.config.js` | `vite.config.ts` |

## Per-File Type Changes

### `web/api.ts`

`apiFetch` becomes generic over the response shape.

```ts
import type { AuthenticatedFetch } from '@shopify/app-bridge/utilities';

export async function apiFetch<T = unknown>(
  authenticatedFetch: AuthenticatedFetch,
  path: string,
  init: RequestInit = {},
): Promise<T> { ... }
```

Callers pass the response type explicitly: `apiFetch<ExampleResponse>(fetcher, '/api/example')`.

### `web/Pages/Home.tsx`

Declare the API response shape and thread it through React Query and `apiFetch`:

```ts
type ExampleResponse = { shopId: string; now: string };

const { data, isLoading, error } = useQuery<ExampleResponse>({
  queryKey: ['example'],
  queryFn: () => apiFetch<ExampleResponse>(fetcher, '/api/example'),
});
```

### `web/bugsnag.tsx`

Give the export a concrete type so consumers can wrap children without `any`:

```ts
const BugSnagBoundary: React.ComponentType<{ children?: React.ReactNode }> =
  Bugsnag.getPlugin('react')?.createErrorBoundary(React) ?? React.Fragment;
```

### `web/App.tsx`, `web/main.tsx`

Rename only — both files are already type-clean once a tsconfig that knows about JSX is in place.

### `vite.config.ts`

`__dirname` is not available in ESM TypeScript. Replace with:

```ts
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
```

## Config Changes

### `tsconfig.json`

- Add `"jsx": "react-jsx"`.
- Add `"DOM"` and `"DOM.Iterable"` to `lib`.
- Add `"vite/client"` to `types` (provides `import.meta.env` typings).
- Replace `include` with `["src/**/*.ts", "src/**/*.tsx", "web/**/*.ts", "web/**/*.tsx", "vite.config.ts"]`.
- Drop `"exclude": ["web"]`.

### `.eslintrc.json`

- The `web/**/*.js, web/**/*.jsx` override becomes `web/**/*.ts, web/**/*.tsx`.
- Add `"parser": "@typescript-eslint/parser"` and `"plugin:@typescript-eslint/recommended"` to that override's extends.
- Disable the base `no-unused-vars` rule and enable `@typescript-eslint/no-unused-vars` in its place.

### `package.json`

- `lint` script: `eslint web --ext .ts,.tsx --fix`.
- Add devDependencies: `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`.

### `index.html`

- `<script type="module" src="/web/main.jsx">` → `/web/main.tsx`.

### `web/CLAUDE.md`

- Update file references: `main.jsx → main.tsx`, `App.jsx → App.tsx`, `Pages/Home.jsx → Pages/Home.tsx`, `api.js → api.ts`, `bugsnag.jsx → bugsnag.tsx`.
- Update lint command extensions if shown.

## Trade-offs

**Single tsconfig for Worker and browser code.** This design uses one `tsconfig.json` for both `src/` (Cloudflare Workers, no DOM) and `web/` (browser, needs DOM). After the change, DOM types are visible inside `src/`. The cleaner alternative is project references with separate `tsconfig.worker.json` and `tsconfig.web.json`. Single config is recommended here because it matches the simplicity of the starter and rarely bites in practice — most Cloudflare/React starters take this approach. Revisit if Worker code accidentally starts depending on DOM-only APIs.

## Verification

- `npm run type-check` passes — covers `src/` and `web/`.
- `npm run vite:build` succeeds.
- `npm run lint` runs without parser errors.

## What This Is Not

- Not a behavior change. Runtime semantics are identical pre- and post-change.
- Not a dependency upgrade. Existing versions of React, Vite, Polaris, etc. stay put.
- Not a test addition. Existing tests (in `src/`) are not touched.
