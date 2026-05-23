# web/ — Frontend (React + Vite + Polaris)

Context for working in this directory. Vite builds a SPA into `dist/`, which is served by the Worker via the `ASSETS` binding (configured in `wrangler.toml`).

---

## Commands

```bash
npx vite                # Dev server (proxy to Worker on :8787 via vite.config.js if needed)
npm run vite:build      # Production build → dist/
npm run lint            # ESLint on web/
```

---

## Architecture

- `main.jsx` — entry, mounts `<App />` with `AppProvider` (Polaris), `QueryClientProvider`, `BrowserRouter`
- `App.jsx` — `NavMenu` + routing shell wrapped in the Bugsnag error boundary
- `Pages/Home.jsx` — example page; replace/extend as you build your app
- `api.js` — `apiFetch` helper; pass it an `authenticatedFetch` created via `useAppBridge()` + `@shopify/app-bridge/utilities`
- `bugsnag.jsx` — env-driven, no-op if `VITE_BUGSNAG_API_KEY` is unset

App Bridge is initialized via the `<script>` tag in `index.html` (`data-api-key="%VITE_SHOPIFY_CLIENT_ID%"`) — no React Provider needed.

---

## Conventions

- **Always use Polaris components** for UI — don't reach for raw HTML/CSS unless Polaris cannot express what you need.
- **Use `apiFetch` for backend calls** — it adds the session-token header so the Worker's `requireShop` middleware succeeds.
- **Loading and error states** — every async UI must show a spinner/skeleton on load and a Polaris `Banner` on error. No blank pages.
