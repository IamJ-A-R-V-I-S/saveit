# Sample Statement — Data Profile

Analysis of `report_2026-10-18_195523.csv`, the reference document type for the
Analyzer agent. Everything here was measured, not assumed.

---

## 1. Shape

| | |
|---|---|
| Rows | 5,535 (5,309 expense / 226 income) |
| Columns | 19, `;`-delimited |
| Period | 2024-01-01 → 2026-09-26 (33 months) |
| Currency | INR only |
| Total income | ₹587,593 |
| Total spend | ₹582,332 |
| Median monthly spend | ₹18,294 |
| Distinct categories | 147 |
| Distinct notes | 724 (only 1,143 rows / 21% have one) |
| Distinct payees | 14 (only 95 rows have one) |

**Source:** this is an export from a personal-finance tracker app, *not* a bank
statement. That distinction drives the whole Analyzer design — see §5.

### Columns

```
account  category  currency  amount  ref_currency_amount  type  payment_type
payment_type_local  note  date  gps_latitude  gps_longitude
gps_accuracy_in_meters  warranty_in_month  transfer  payee  labels
envelope_id  custom_category
```

### Accounts

| Account | Txns | Spend | Income |
|---|---|---|---|
| Cash | 3,097 | ₹100,072 | ₹71,224 |
| SBI-Reja | 2,345 | ₹442,705 | ₹491,869 |
| Slice bank | 77 | ₹23,555 | ₹10,500 |
| Slice | 2 | ₹9,000 | — |
| Saving(mom) | 14 | ₹7,000 | ₹14,000 |

Cash is **59% of transactions but only 17% of spend**. No bank statement will
ever contain cash, so `accounts.manual_only = true` for cash accounts and the
coverage report must not treat missing cash rows as missing data.

---

## 2. `envelope_id` is a hidden taxonomy

The file carries a sector→product hierarchy in plain sight. `category` is the
product level; `envelope_id` is the sector level:

```
5002  Beverages    → Cha(785) Coca-Cola(286) Thumbs-up(131) Sugarcane juice(121)
                     Lassi(94) Water(30) Drinks(19) Aam pora(19) Coffee(16) Glucose(15)
5003  Snacks       → Curd(122) Tiffin(56) Chop(39) Muri(38) Ice cream(17) Sweets(10)
2005  Groceries    → Milk(321) Biscuits(300) Grocery(305) Eggs(221) Coffee powder(43)
                     Chanachur(35) Maggi(26) Daliah(21) Cake(21) …
4000  Local travel → Auto(185) Metro(73) Bus(68) Local train(46) Toto(20)
8006  Meals        → Rice-chicken(98) Rice-egg(33) LUNCH(34) Rice-curry(26) Rice-fish(16)
```

**Consequence:** the user does not need to invent a sector→product taxonomy.
60+ sectors and 147 products already exist in the data. The platform's job is to
*recover* that hierarchy and keep it clean — not to impose a generic one.

`envelope_id` is therefore mapped into `sectors`, and `category` into `products`.

---

## 3. Six problems the data forced into the design

### 3.1 The category list is inconsistent

`guava` (lowercase) sits beside `Mango` and `Apple`. `Eggs 🥚` carries emoji.
`Chanachur0` is a typo. `Idli sambar` and `Idli-sambar` are two spellings.
`Ruti-tarka` / `Roti-curry` / `Ruti-curry` / `Rutu-curry-egg` overlap.
Two categories are emoji-only: `👖`, `👕`.

→ `canonicalProductName()` strips emoji, fixes known typos and sentence-cases.
`normalizeProductName()` folds to alphanumerics only for uniqueness. Emoji-only
names become `Unknown` rather than an empty product, so they reach the review
queue.

### 3.2 Coverage is not contiguous

Transactions per month range from **14** (2026-09) to **267** (2026-06):

```
2024-09:  89     2025-03: 226     2026-03:  74
2024-07: 128     2025-08: 206     2026-08:  30
2024-08: 123     2025-12: 172     2026-09:  14
```

Statements arrive covering partial and overlapping periods.

→ `v_monthly_coverage` exposes `tx_count` and `categorize_pct` per month so the
Coach can refuse to report a fake "you saved money in March" from a month that
only has 74 of its usual ~200 rows.

### 3.3 Distinct transactions collide at minute precision

Four pairs in the file are identical down to the minute:

```
SBI-Reja | 2026-06-28 19:10:52 | -58.00  | Grocery
SBI-Reja | 2026-06-28 19:10:22 | -58.00  | Grocery
SBI-Reja | 2026-06-28 13:20:45 | -100.00 | Chicken Biryani
SBI-Reja | 2026-06-28 13:20:18 | -100.00 | Chicken Biryani
SBI-Reja | 2024-05-15 17:46:43 | -542.00 | Charges, Fees   note="Exam fees for 4th sem"
SBI-Reja | 2024-05-15 17:46:24 | -542.00 | Charges, Fees   note="For CR exam fees 4th sem"
```

That last pair is two real ₹542 exam-fee payments — one for the user, one for a
classmate. At minute precision the dedup key would treat one as a duplicate and
**silently drop it**.

Measured: minute precision → 5,531 unique keys, **4 rows lost**.
Second precision → 5,535 unique keys, **0 rows lost**.

→ `make_dedup_key()` uses `HH24:MI:SS` plus an in-batch `occurrence` ordinal for
rows identical even to the second (or date-only statements with no time at all).
`scripts/test-dedup-parity.mjs` pins the TS and SQL implementations to the same
output, because drift between them would double-count on any SQL backfill.

### 3.4 Split transactions must survive

```
Radhikapur express  -282.00  2024-02-16
Radhikapur express  -262.00  2024-02-02 17:44:14   note="Rgn to naihati"
Radhikapur express  -262.00  2024-02-02 17:43:11   note="Koaa - Rgn"
```

Two legs of one journey, one minute apart, same amount. Amounts differ from the
₹282 leg, and the seconds differ between the two ₹262 legs — so second-precision
dedup keeps all three, which is correct.

### 3.5 "What is it" ≠ "what is it for"

The single largest expense category is `Loan, interests` (₹84,983, 54 txns) — but
the notes say otherwise:

```
Me → Ayantika : myntra 2 product(1628+1029) received by Arun    -2,657
Me → Ayantika : Natural lifestyle                                -2,719
Me → Kiron : Shopping                                              -500
```

This is **lending money to people**, not paying interest. Meanwhile `Rent`
(₹62,602) bundles "Room rent + electric + water + cleanup".

→ A category alone cannot carry both meanings. `note` and `payee` are folded into
the description string the categorizer reads, and `Charges, Fees` is deliberately
seeded into `uncategorized` so the model must read the note ("Exam fees" →
education, "Brokerage" → housing, "For maid" → housing) instead of inheriting a
wrong default.

### 3.6 Quoted fields span multiple lines

```
"Ayantika → Me : Gpay (sixer)
$3922 to go"
```

→ `parseDelimited()` is a real state machine over the whole buffer. A naive
`split('\n')` corrupts the file. Verified: all 5,535 data rows yield exactly 19
fields.

---

## 4. Measured: what the deterministic path resolves

Running the shipped parser + seed taxonomy over the whole file, **with no LLM
calls at all**:

```
parsed rows       : 5535
staged OK         : 5535     (0 skipped — every row parsed)
dedup             : 5535 unique keys, 0 false collisions

resolution path:
  exact    5534   100.0%
  alias       0     0.0%
  keyword     0     0.0%
  none        1     0.0%     ← "Ericsson", an employer name

rows needing the LLM: 1 (0.02%)
rows resolved free  : 5534 (99.98%)
```

This is the payoff of *deterministic first, LLM second*. A 5,535-row import costs
**one** model call, and that call also teaches the system the "Ericsson" product
so the next import costs zero.

For a *bank* PDF the numbers will be worse — merchant strings like
`UPI/5283/SWIGGY/BANG` are not clean product names — which is exactly where the
LLM and the learned alias table earn their keep.

---

## 5. Why this file is not representative of a bank statement

| | Tracker export (this file) | Bank statement |
|---|---|---|
| Description | Clean product name (`Cha`) | Mangled merchant (`UPI/5283/SWIGGY/BANG`) |
| Category | Provided | Absent |
| Note | 21% of rows, human context | Absent |
| Delimiter | `;` | `,` or fixed-width |
| Header row | Row 0 | Often after preamble |
| Sign convention | Negative = expense | Dr/Cr column, or separate columns |
| Cash | 59% of txns | Never present |

The Analyzer therefore needs **per-document-type strategies**. `mapColumns()`
handles the structural variety deterministically; the categorization prompt is
where document type matters, because a tracker export hands the model the answer
(`category`) while a bank statement hands it a puzzle.

---

## 6. The savings signal (what the Coach should surface)

```
Snack / drink cluster    ₹26,605 over 1,897 txns
                         = 4.6% of spend but 33% of ALL transactions
  Cha              785 txns   ₹6,250
  Coca-Cola        286 txns   ₹5,642
  Biscuits         300 txns   ₹1,956
  Sugarcane juice  121 txns   ₹2,773
  Thumbs-up        131 txns   ₹2,636
  Lassi             94 txns   ₹1,528

Commute split        185 Auto rickshaws (₹3,908)  vs  34 Ubers (₹2,799)
Top single category  Loan, interests ₹84,983 — but see §3.5, it is lending
Rent                 ₹62,602 — bundles electricity, water, cleaning
```

High-frequency low-ticket clusters are the Coach's best target: individually
trivial, collectively ₹26,605, and behaviourally compressible. That is the kind
of finding the ranked-opportunity output is built to express — with the 1,897
transaction ids attached as evidence.
