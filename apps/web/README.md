# SaveIt — web app

Next.js 16 (App Router) frontend: upload → dashboard → review queue → insights.

```bash
cd apps/web
cp .env.example .env.local     # fill in URL + anon key from Supabase → Project Settings → API Keys
npm install
npm run dev                    # http://localhost:3000
```

`npm run build` / `npm run lint` / `npx tsc --noEmit` all pass clean.

## How it's put together

| Layer | Where | Notes |
|---|---|---|
| Session refresh + route guard | `proxy.ts`, `lib/supabase/proxy.ts` | Next 16 renamed `middleware.ts` → `proxy.ts`. Optimistic cookie check only. |
| Authoritative auth check | `app/(app)/layout.tsx` | `getUser()` (round-trips to auth), not `getSession()`. |
| Reads | `lib/data/*` | Server-only. Mostly the `security_invoker` views. **No `.eq('user_id')` anywhere** — RLS does the scoping in one place. |
| Writes | `lib/actions/*` | Server Actions. Plain CRUD goes through PostgREST as the user. |
| Agent calls | `lib/edge.ts` | Forwards the **user's** access token to the edge functions (the anon key would 401). Recognizes "not deployed" and says so. |
| Charts | `components/charts.tsx` | Hand-rolled SVG, server-rendered. No chart library, no hydration risk. |

Things that are deliberate:

- **No service-role key in this app.** It only exists in edge-function secrets.
- **Parsing is not duplicated here.** Uploads are forwarded to the `ingest` function, so the parser,
  dedup key and resolver live in one place (`supabase/functions/_shared`).
- **Manual entry computes its dedup key in the database** (`make_dedup_key` RPC), so a hand-typed
  expense and the same row imported later can't both land in the ledger.
- **Sparse months are hatched, not drawn as dips.** "Sparse" means under 30% of *your* median
  monthly transaction count.
- **Correcting a category tries `correct` first** (writes an alias, so it's learned). If that
  function isn't deployed it falls back to a direct update and tells you nothing was learned.
- **Fonts are self-hosted** via the `geist` package. `next/font/google` fails the build outright
  wherever fonts.googleapis.com is unreachable.

## Pages

`/dashboard` · `/upload` · `/transactions` (URL-driven filters, bulk categorize, manual entry) ·
`/review` (grouped by description; one decision clears every matching row) · `/insights`
(coach output with expandable evidence) · `/taxonomy` (merge duplicates, move products, learned
aliases) · `/budgets` · `/documents` · `/settings` (profile, Telegram, **backend health check**) ·
`/onboarding`.

## What needs the backend

Pages and plain CRUD work as soon as the database is migrated. These need the edge functions
deployed: **upload** (`ingest`), **categorize now** (`categorize`), **run the coach** (`coach`),
**learned corrections** (`correct`), **Telegram test** (`notify`). Settings → Backend shows which
are live.
