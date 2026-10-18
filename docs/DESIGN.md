# SaveIt — Design Doc

> Upload a bank / UPI / tracker statement → get categorized expenses, a living
> taxonomy, and a coach that tells you where the money is leaking.

---

## 1. The idea

Classic expense trackers make **you** do the accounting: open app, pick category,
pick subcategory, type amount, repeat 40× a day. The category tree is fixed by
the vendor, so it never matches how you actually think about money.

SaveIt flips it. **You upload a statement. The system does the accounting.**

```
Upload statement ──▶ Parse (deterministic where possible) ──▶ Normalize
                                                                   │
                                                          Categorize (LLM)
                                                                   │
                                                        ┌──────────┴──────────┐
                                                   transactions        review queue
                                                   (auto)              (low confidence)
                                                        │
                                                   Dashboard
                                                        │
                                            Coach (scheduled)
                                                        │
                                       insights  ──▶  Telegram push
```

Two agents, two jobs:

| Agent | Trigger | Job | Output |
|---|---|---|---|
| **Analyzer** | On upload | Extract rows, categorize them | `transactions` + `products` |
| **Coach** | Scheduled (pg_cron) | Find patterns, rank savings opportunities | `insights` → dashboard + Telegram |

---

## 2. Decisions (locked with the user)

| Area | Decision | Why |
|---|---|---|
| Ingestion | CSV/XLSX + text PDFs + scanned PDFs (OCR) + manual entry | "Anything + manual fallback" |
| Taxonomy | **Hybrid** — fixed sectors, LLM-managed products | Stable reporting + adapts to real life |
| Scope | Full tracker **and** statement parser | Manual entry for what statements miss |
| Users | Multi-tenant from day 1 | Per-user data, per-user LLM budget |
| LLM | Provider adapter, default **Gemini** | Free tier + native PDF + vision for OCR |
| Coach delivery | In-app dashboard **+ Telegram** | Dashboard for depth, push for the nudge |
| Frontend | Next.js App Router | SSR, file routing, first-class Supabase auth |
| Autonomy | Auto-categorize, low-confidence → review queue | Fast ingest, still correctable |
| Coach output | Ranked opportunities + ₹ estimate + evidence | Actionable, not just descriptive |
| Budgets | Sector budgets **and** savings goals | Gives the coach something to aim at |
| Milestone 1 | Full pipeline end-to-end on CSV | Proves the whole idea first |

**Core engineering principle: deterministic first, LLM second.**
Never spend an LLM call to read a CSV. The LLM is only needed for
(a) extracting rows from unstructured documents and (b) categorizing.

---

## 3. The data (from the sample statement)

`report_2026-10-18_195523.csv` — 5,535 rows, 2024-01-01 → 2026-09-26, INR only.

### 3.1 What it revealed

1. **`envelope_id` is a hidden sector→product taxonomy.** 60+ envelopes already
   map to products, e.g. `5002` → Cha, Thumbs-up, Coca-Cola, Lassi, Water.
   The `category` column is the *product* level, flattened.
2. **138 distinct categories, heavily overlapping.** `guava` / `Mango` / `Apple`
   are products; `Grocery` is a sector; `Ruti-tarka` / `Roti-curry` /
   `Ruti-curry-egg` are three spellings of one meal. `Chanachur0` is a typo.
3. **Notes are the highest-value signal but only 21% of rows have them.**
   "Pineapple shake", "Me → Kiron : Shopping", "Brokerage", "Teeth" — this is
   what makes a row categorizable. A bank PDF won't have notes; it'll have a
   mangled merchant description string instead. **The Analyzer's job differs
   per document type** and the prompt must too.
4. **Coverage is not contiguous.** Transactions per month range from 14
   (2026-09) to 267 (2026-06). Statements arrive covering partial, overlapping
   periods → **idempotent upsert is mandatory**.
5. **Split transactions exist.** `Radhikapur express` ₹282 + ₹262 on the same
   day = two legs of one trip. Must not be merged, and must not be double
   counted.
6. **"What is it" ≠ "what is it for".** Top category `Loan, interests` (₹85k) is
   mostly *"Me → Ayantika : Myntra order"* — lending money, not interest. `Rent`
   (₹62k) bundles electricity + water + cleaning. Classification needs a
   *purpose* axis alongside the category axis.

### 3.2 The savings signal (what the Coach should find)

```
Snack / drink cluster   ₹26,605 across 1,897 txns  (4.6% of spend, 33% of txns)
  Cha           785 txns  ₹6,250      Coca-Cola   286 txns  ₹5,642
  Biscuits      300 txns  ₹1,956      Sugarcane   121 txns  ₹2,773
  Thumbs-up     131 txns  ₹2,636      Lassi        94 txns  ₹1,528

Commute:  185 Auto rickshaws (₹3,908)  vs  34 Ubers (₹2,799)
Median monthly spend ₹18,294   ·   income ₹587,593   ·   spend ₹582,332
```

Cash = 59% of *transactions* but only 17% of *spend*. No bank statement will
ever contain cash → **Cash is a manual-entry-only account**.

---

## 4. Data model

```
profiles ──┬── accounts ──────┐
           │                   │
           ├── sectors ── products ── aliases
           │                   │         (learned merchant → product rules)
           ├── documents ─────┤
           │                   ├── transactions ── corrections
           ├── budgets / goals
           └── insights
```

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | user + LLM quota | `id`, `llm_daily_cap`, `telegram_chat_id` |
| `sectors` | **fixed** top-level taxonomy | `id`, `slug`, `name`, `icon`, `sort` |
| `products` | LLM-managed, grows + merges | `id`, `sector_id`, `name`, `aliases[]`, `status` |
| `aliases` | learned rules | `product_id`, `pattern`, `source`, `confidence` |
| `accounts` | bank / cash / wallet | `name`, `kind`, `manual_only` |
| `documents` | uploaded statement | `kind`, `path`, `sha256`, `status`, `coverage` |
| `transactions` | the ledger | `account_id`, `amount`, `direction`, `occurred_at`, `product_id`, `confidence`, `source_ref` |
| `corrections` | user overrides | `transaction_id`, `old_product_id`, `new_product_id` |
| `insights` | coach output | `kind`, `sector_id`, `headline`, `saving_estimate`, `evidence jsonb` |
| `budgets` / `goals` | targets | `period`, `amount`, `sector_id` / `target`, `deadline` |

### 4.0 Security note on views

Every analytics view is created `with (security_invoker = true)`. Postgres views
otherwise execute with the *owner's* privileges, which bypasses RLS entirely —
any authenticated user could read every user's ledger through
`v_monthly_sector_spend`. `security_invoker` makes the view apply the querying
role's policies instead. Requires Postgres 15+ (Supabase runs 17).

`merge_products()` is `security definer` (it must move rows across tables) and
is revoked from `public`, granted only to `authenticated`.

### 4.1 Idempotency

```
dedup_key = sha256(user_id | account | occurred_at::date | amount | normalized_description)
```

`ON CONFLICT (user_id, dedup_key) DO UPDATE`. Re-uploading an overlapping
statement is a no-op. `normalized_description` lowercases, strips
whitespace/punctuation and collapses digits so `Radhikapur express` and
`RADHIKAPUR EXPRESS ` collapse to one key — but the two same-day legs have
different amounts, so they stay distinct.

---

## 5. Ingestion pipeline

```
┌─ CSV / XLSX ────────────────────────────────────────────┐
│ deterministic header-map → column-role detection          │
│ (date | amount | direction | description | account | note)│
│ NO LLM. Handles ; , \t | auto-detect.                    │
└───────────────────────────────────────────────────────────┘
┌─ PDF (text) ─────────────────────────────────────────────┐
│ extract text → if < 30% of pages have text → OCR path    │
│ LLM table extraction → normalized rows                  │
└───────────────────────────────────────────────────────────┘
┌─ PDF (scanned) ──────────────────────────────────────────┐
│ render page → Gemini vision → structured rows            │
└───────────────────────────────────────────────────────────┘
┌─ Manual entry ───────────────────────────────────────────┐
│ form → normalized row → categorize (same path)           │
└───────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Normalize → staging rows
                    (date, amount, direction, account,
                     raw_text, source_ref = file+line/page)
                              │
                              ▼
                    Dedupe (upsert on dedup_key)
                              │
                              ▼
                    Categorize (LLM + aliases + taxonomy)
                    confidence ≥ 0.75 → auto-accepted
                    confidence <  0.75 → review queue
```

**Column-role detection** is deterministic: match header names against
known aliases (`amount|amt|value|txn amount`, `date|txn date|posted`,
`description|narration|particulars|details|remarks|payee`). If a required role
is missing, the ingest is queued for LLM-assisted mapping — and *that* mapping
is cached per file signature so the next file of the same type is free.

**Categorization** prompt gets: the sector list, the user's product list
(with aliases), the transaction's raw text, and up to 8 similar *already
categorized* transactions from the same user as few-shot examples. Output is
strict JSON: `{product, sector, confidence, reason}`.

**Learning loop:** every correction writes an `aliases` row (normalized pattern
→ product) with a `source='correction'`. The alias table is consulted before
the LLM, so a corrected pattern never costs a token again.

---

## 6. The Coach

Runs on a schedule (pg_cron → Edge Function). Never asks the LLM to look at
raw transactions — it asks it to look at **aggregates**, which is both cheap
and more accurate.

```
1. Query aggregates: spend by sector / product / merchant, per month,
   3-month trends, tx counts, top recurring patterns
2. Build a compact JSON brief (few hundred numbers, not 5,535 rows)
3. LLM → ranked opportunities:
   { headline, sector_id, monthly_saving_estimate, confidence,
     evidence: [transaction_ids], reasoning }
4. Persist to `insights`
5. Push top N to Telegram
6. In-app dashboard reads `insights`
```

Evidence is a list of `transaction_id`s so the UI can show exactly which rows
back a claim. No unsourced advice.

---

## 7. Repo layout

```
saveit/
├── apps/web/                 Next.js App Router frontend
│   └── src/app/              (auth) · (app)/* routes
├── supabase/
│   ├── migrations/            numbered SQL, applied in order
│   └── functions/
│       ├── _shared/           llm · taxonomy · parse · normalize · db
│       ├── ingest/            upload → parse → normalize → dedupe → stage
│       ├── categorize/        LLM categorize + alias learning
│       ├── coach/             aggregates → opportunities → insights
│       └── notify/            Telegram push
├── docs/
│   ├── DESIGN.md              this file
│   └── DATA-PROFILE.md        full analysis of the sample statement
└── scripts/seed-sample.ts     import the sample CSV into a dev DB
```

---

## 8. Environment

| Secret | Where | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Supabase edge function secret | default LLM |
| `OPENAI_API_KEY` | Supabase edge function secret | alternate LLM |
| `TELEGRAM_BOT_TOKEN` | Supabase edge function secret | push |
| `TELEGRAM_CHAT_ID` | `profiles.telegram_chat_id` | who to push to |
| `SUPABASE_URL` / `SERVICE_ROLE_KEY` | Supabase env | server-side |

LLM keys live in Supabase Edge Function secrets — never in the repo, never in
the browser.
