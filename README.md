# SaveIt

> Upload a statement. The system does the accounting.

Classic expense trackers make **you** do the work — open app, pick category, pick
subcategory, type amount, forty times a day — and then hand you a category tree
the vendor chose. SaveIt inverts that. You drop in a monthly / quarterly / yearly
statement from your bank, UPI app, or tracker, and two agents take it from there:

| Agent | Runs when | Does | Produces |
|---|---|---|---|
| **Analyzer** | on upload | extract rows, normalize, categorize | `transactions` + a living taxonomy |
| **Coach** | on a schedule | find spend patterns, rank savings opportunities | `insights` → dashboard + Telegram |

**Core engineering principle: deterministic first, LLM second.** A CSV is never
sent to a model. On the real 5,535-row statement this was developed against,
**99.98% of rows categorize with zero LLM calls** and zero false dedup
collisions; the model is reserved for genuinely unstructured input (scanned /
text PDFs) and for rows the deterministic resolver can't place.

---

## Status

- [x] **Database** — 9 migrations applied to a live Supabase project (PG 17).
      12 tables, RLS on every one, 7 `security_invoker` views, private
      `statements` storage bucket, 14 seeded sectors, pg_cron + pg_net.
- [x] **Database integration test** — 13/13 assertions pass against the live
      project; self-cleaning.
- [x] **Ingestion core** — deterministic parser, normalizer, taxonomy resolver,
      provider-agnostic LLM adapter, PDF/image/text extraction.
- [x] **Edge functions** — 6 written (`ingest`, `categorize`, `coach`,
      `coach-cron`, `notify`, `correct`).
- [x] **Local test suite** — parser, dedup parity, taxonomy, end-to-end pipeline
      fixture. All pass.
- [x] **Frontend** — Next.js 16 app in [`apps/web`](apps/web): dashboard, upload,
      transactions, review queue, insights, taxonomy, budgets, documents, settings.
      Build, lint and typecheck clean.
- [x] **Security regression test** — `merge_products` can't be used across
      tenants (9/9 against the live project; see migration 0009).
- [ ] **Deploy edge functions** to Supabase + set secrets. Until then, upload,
      categorize, coach and learned corrections report "not deployed".

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design and the locked
decisions, and [`docs/DATA-PROFILE.md`](docs/DATA-PROFILE.md) for the measured
analysis of a real statement that drove several of those decisions.

---

## Layout

```
apps/
  web/                 Next.js 16 frontend — see apps/web/README.md
supabase/
  migrations/          0001 schema · 0002 RLS · 0003 sectors · 0004 views
                       0005 storage · 0006 aliases · 0007 recurring+cron · 0008 use_count
                       0009 lock down SECURITY DEFINER RPCs
  functions/
    _shared/           parse · normalize · taxonomy · taxonomy-seed · llm
                       extract · db · seed · types
    ingest/            upload → parse → stage → dedup → resolve → review queue
    categorize/        drain the review queue with the LLM
    coach/             compute spend patterns, rank savings opportunities
    coach-cron/        scheduled coach run (pg_cron → pg_net)
    notify/            deliver an insight to Telegram
    correct/           user correction → alias, so the same mistake never recurs
scripts/
  run-tests.sh         local suite (no deploy, no Deno, no secrets needed)
  run-db-tests.sh      database integration test (needs SUPABASE_DB_URL)
  fixtures/            synthetic 30-row tracker export — no private data
docs/                  DESIGN.md · DATA-PROFILE.md
```

---

## Run the tests locally

No build step, no Deno install, no Supabase project, no API keys. Uses Node's
built-in type stripping (Node 22+):

```bash
./scripts/run-tests.sh
```

That covers the deterministic parser (delimiters, header rows, column roles,
amount and date disambiguation), the dedup-key contract, the taxonomy resolver
and canonicalizer, and a 30-row end-to-end pipeline fixture.

### Dedup parity

The dedup key is computed in **two** places — TypeScript for staging, SQL for
the database. They must agree byte-for-byte or silent duplicates appear.
`scripts/test-dedup-parity.mjs` pins this: it computes keys in TS and asserts
they equal the SHA-256 the SQL `make_dedup_key()` produces. **Never change one
side without the other.**

### Database integration test

Needs a live project:

```bash
SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
  ./scripts/run-db-tests.sh
```

It creates a throwaway user, asserts 13 things (signup trigger, seeding,
second-precision dedup, re-upload idempotency, `use_count` maintenance on
insert / delete / update, view aggregation, `security_invoker` on all views,
product merging, RLS enabled, recount), then deletes the auth row so every FK
cascades away.

---

## Deploying

```bash
# 1. migrations
supabase db push

# 2. functions
supabase functions deploy ingest
supabase functions deploy categorize
supabase functions deploy coach
supabase functions deploy coach-cron
supabase functions deploy notify
supabase functions deploy correct

# 3. secrets
supabase secrets set \
  GEMINI_API_KEY=... \
  CRON_SECRET=... \
  TELEGRAM_BOT_TOKEN=...
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically.
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GEMINI_MODEL` and
`OPENAI_MODEL` are optional — see the secrets table in `docs/DESIGN.md`.

The Coach cron job is **not** created by migration `0007` unless these two GUCs
are set first, so the deploy is inert until you opt in:

```sql
alter database postgres set app.settings.saveit_cron_url     = '<coach-cron URL>';
alter database postgres set app.settings.saveit_cron_secret  = '<CRON_SECRET>';
```

---

## Design notes worth knowing

**Hybrid taxonomy.** Sectors are fixed (14, seeded, read-only) so reporting
stays comparable month over month. Products under them are LLM-managed and grow
to match how *you* describe money — `Cha`, `Thumbs-up`, `Sugarcane juice` are
real products here, not "Beverages".

**Every correction teaches the system.** When a user fixes a miscategorization,
`correct/` writes an alias, so the identical description never reaches the LLM
again. Per-user, so nobody's corrections leak into anyone else's ledger.

**RLS everywhere, including views.** Postgres views bypass row-level security by
default — they run with owner privileges. Every view here is declared
`with (security_invoker = true)` (PG 15+), or one authenticated user could read
the entire ledger through `v_monthly_sector_spend`.

**Low confidence goes to review, not to a guess.** Exact matches on
deliberately ambiguous sectors (`Charges, Fees` covers exam fees, brokerage, a
maid and a freelancer in the sample data) are routed to the review queue rather
than auto-accepted at high confidence.
