# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository. Subdirectory CLAUDE.md files (`src/CLAUDE.md`, `web/CLAUDE.md`) contain context scoped to those trees.

---

## Project Overview

**cloudflare-shopify-starter** — Shopify embedded app starter on Cloudflare Workers + Hono + D1 + KV + R2 + React + Polaris. Built on production-tested patterns; ships with session-token auth, KV-backed Shopify session storage, Drizzle ORM, and a minimal one-page React + Polaris frontend.

See `README.md` for setup. See `wrangler.jsonc` for which Cloudflare bindings are wired in (D1, KV, R2) and which are commented out as opt-in examples (Queues, Durable Objects, Cron).

---

## Architecture

| Layer | Technology |
|---|---|
| Worker runtime | Cloudflare Workers (Hono) |
| Database | Cloudflare D1 (SQLite) + Drizzle ORM |
| Sessions | Cloudflare KV (`SESSION_KV`) |
| File storage | Cloudflare R2 (`R2` binding) |
| Frontend | React 18 + Vite + Shopify Polaris (SPA, `dist/` via `[assets]`) |
| Auth | Shopify session tokens (JWT) via App Bridge |

---

## Key Design Decisions

- **All IDs are `crypto.randomUUID()`** — not auto-increment.
- **Timestamps are ISO 8601 strings** stored as `text()` (no SQLite `datetime` type).
- **One table to start (`shopify_shop`)** — every additional table you add should reference it via a non-null `shopId` text FK with `onDelete: 'cascade'` (GDPR `SHOP_REDACT` pattern).

---

## Code Quality Rules

- **Secure routes by default** — all `/api/*` routes are protected by `requireShop` middleware. Making a route public is an exception and requires an explicit entry in `PUBLIC_API_PATHS` with a comment justifying it.
- **Never use raw `KV.get()` + `JSON.parse()` for sessions** — always use `KVSessionStorage.loadSession()`.
- **Fail loudly on data integrity issues** — never use `?? ''` or fallbacks to mask a missing domain, ID, or required field.
- **Never pass secrets through queue messages** — fetch tokens from KV at processing time.

---

## Database Diagram

`docs/erd.dbml` is the ERD for the D1 schema, in [dbdiagram.io](https://dbdiagram.io/d) DBML format. Paste the file's contents into dbdiagram.io to render it.

**When a new feature changes the schema:** propose the DB design first and wait for the user to approve it. Once approved — and in the same change as the Drizzle schema edit and the migration — update `docs/erd.dbml` to match. Never update the diagram ahead of approval, and never land a schema change that leaves it stale.

Keep the DBML faithful to `src/db/schema.ts`: enum values and `0/1` boolean semantics go in column `note`s, named indexes are mirrored in `indexes { }`, and a `shopId` FK is drawn as a `ref` with its `ON DELETE CASCADE` noted.
