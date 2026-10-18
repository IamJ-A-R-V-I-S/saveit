-- =============================================================================
-- SaveIt — 0001 : core schema
-- Multi-tenant expense intelligence platform.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- profiles : one row per user, created by trigger on auth.users insert
-- -----------------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  email              text,
  full_name          text,
  default_currency   text not null default 'INR',
  telegram_chat_id   text,
  telegram_enabled   boolean not null default false,
  llm_daily_cap      integer not null default 200 check (llm_daily_cap > 0),
  onboarded          boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- sectors : FIXED top-level taxonomy. Global (not per-user).
-- Products live underneath and are managed by the LLM per user.
-- -----------------------------------------------------------------------------
create table public.sectors (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  icon        text,
  description text,
  sort_order  integer not null default 100,
  is_system   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- products : per-user, LLM-managed. Grow over time; merge when near-duplicates
-- appear. Belongs to exactly one sector.
-- -----------------------------------------------------------------------------
create table public.products (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  sector_id       uuid not null references public.sectors (id) on delete restrict,
  name            text not null,
  normalized_name text not null,
  status          text not null default 'active'
                    check (status in ('active', 'merged', 'archived')),
  merged_into     uuid references public.products (id) on delete set null,
  use_count       integer not null default 0,
  is_seeded       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index products_user_idx on public.products (user_id, status);
create index products_user_name_idx on public.products (user_id, normalized_name);
create unique index products_user_active_name_idx
  on public.products (user_id, normalized_name) where status = 'active';

-- -----------------------------------------------------------------------------
-- aliases : learned rules mapping a description pattern -> product.
-- user_id null => global rule (shared merchant knowledge).
-- -----------------------------------------------------------------------------
create table public.aliases (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete cascade,
  pattern      text not null,
  pattern_type text not null default 'contains'
                 check (pattern_type in ('exact', 'contains', 'regex')),
  source       text not null default 'correction'
                 check (source in ('correction', 'llm', 'seed', 'user', 'global')),
  confidence   numeric(4, 3) not null default 1.0 check (confidence >= 0 and confidence <= 1),
  hit_count    integer not null default 0,
  created_at   timestamptz not null default now()
);

create index aliases_user_pattern_idx on public.aliases (user_id, pattern);
create index aliases_product_idx on public.aliases (product_id);

-- -----------------------------------------------------------------------------
-- accounts : bank / cash / wallet / card
-- manual_only = true for accounts no statement will ever contain (e.g. Cash).
-- -----------------------------------------------------------------------------
create table public.accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  kind         text not null default 'bank'
                 check (kind in ('bank', 'cash', 'wallet', 'credit_card', 'upi',
                                 'investment', 'savings', 'other')),
  institution  text,
  currency     text not null default 'INR',
  manual_only  boolean not null default false,
  is_archived  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index accounts_user_idx on public.accounts (user_id) where not is_archived;

-- -----------------------------------------------------------------------------
-- documents : an uploaded statement and its parse status
-- -----------------------------------------------------------------------------
create table public.documents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  account_id       uuid references public.accounts (id) on delete set null,
  filename         text not null,
  storage_path     text,
  kind             text not null check (kind in ('csv', 'xlsx', 'pdf', 'json', 'other')),
  source_type      text,
  sha256           text,
  size_bytes       bigint,
  status           text not null default 'uploaded'
                     check (status in ('uploaded', 'parsing', 'parsed', 'failed', 'needs_review')),
  period_start     date,
  period_end       date,
  row_count        integer,
  imported_count   integer default 0,
  duplicate_count  integer default 0,
  error_message    text,
  coverage         jsonb,
  header_map       jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index documents_user_idx on public.documents (user_id, created_at desc);
create index documents_sha_idx on public.documents (user_id, sha256);

-- -----------------------------------------------------------------------------
-- transactions : the ledger. amount is always a positive magnitude; direction
-- carries the sign. dedup_key makes re-uploading an overlapping statement safe.
-- -----------------------------------------------------------------------------
create table public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  account_id         uuid not null references public.accounts (id) on delete cascade,
  document_id        uuid references public.documents (id) on delete set null,
  product_id         uuid references public.products (id) on delete set null,
  amount             numeric(14, 2) not null check (amount >= 0),
  direction          text not null check (direction in ('debit', 'credit')),
  currency           text not null default 'INR',
  occurred_at        timestamptz not null,
  raw_description    text,
  note               text,
  payee              text,
  dedup_key          text not null,
  source_ref         jsonb,
  categorize_status  text not null default 'pending'
                       check (categorize_status in ('pending', 'auto', 'review', 'corrected', 'skipped')),
  confidence         numeric(4, 3),
  categorize_reason  text,
  llm_model          text,
  is_recurring       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index transactions_dedup_idx on public.transactions (user_id, dedup_key);
create index transactions_user_time_idx on public.transactions (user_id, occurred_at desc);
create index transactions_user_product_idx on public.transactions (user_id, product_id);
create index transactions_review_idx on public.transactions (user_id)
  where categorize_status = 'review';
create index transactions_account_idx on public.transactions (account_id, occurred_at desc);
create index transactions_pending_idx on public.transactions (user_id)
  where categorize_status = 'pending';

-- -----------------------------------------------------------------------------
-- corrections : every user override. These become aliases (the learning loop).
-- -----------------------------------------------------------------------------
create table public.corrections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  old_product_id  uuid references public.products (id) on delete set null,
  new_product_id  uuid not null references public.products (id) on delete cascade,
  created_at      timestamptz not null default now()
);

create index corrections_user_idx on public.corrections (user_id, created_at desc);
create index corrections_tx_idx on public.corrections (transaction_id);

-- -----------------------------------------------------------------------------
-- insights : coach output. evidence holds transaction ids so every claim is
-- traceable back to real rows.
-- -----------------------------------------------------------------------------
create table public.insights (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  period_start              date,
  period_end                date,
  kind                      text not null default 'opportunity'
                              check (kind in ('opportunity', 'anomaly', 'goal_progress', 'summary')),
  rank                      integer,
  sector_id                 uuid references public.sectors (id) on delete set null,
  product_id                uuid references public.products (id) on delete set null,
  headline                  text not null,
  detail                    text,
  monthly_saving_estimate   numeric(14, 2),
  confidence                numeric(4, 3),
  evidence                  jsonb not null default '[]'::jsonb,
  status                    text not null default 'new'
                              check (status in ('new', 'seen', 'dismissed', 'accepted', 'acted_on')),
  llm_model                 text,
  created_at                timestamptz not null default now()
);

create index insights_user_idx on public.insights (user_id, created_at desc);
create index insights_user_period_idx on public.insights (user_id, period_start desc);

-- -----------------------------------------------------------------------------
-- budgets : spending caps per sector
-- -----------------------------------------------------------------------------
create table public.budgets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  sector_id  uuid not null references public.sectors (id) on delete cascade,
  period     text not null default 'monthly'
               check (period in ('weekly', 'monthly', 'quarterly', 'yearly')),
  amount     numeric(14, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index budgets_user_sector_period_idx
  on public.budgets (user_id, sector_id, period);

-- -----------------------------------------------------------------------------
-- goals : savings targets
-- -----------------------------------------------------------------------------
create table public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  target_amount numeric(14, 2) not null check (target_amount > 0),
  saved_amount  numeric(14, 2) not null default 0 check (saved_amount >= 0),
  deadline      date,
  status        text not null default 'active'
                  check (status in ('active', 'reached', 'cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index goals_user_idx on public.goals (user_id) where status = 'active';

-- -----------------------------------------------------------------------------
-- llm_usage : per-user token accounting + quota enforcement
-- -----------------------------------------------------------------------------
create table public.llm_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  fn                text not null,
  model             text not null,
  provider          text not null default 'gemini',
  prompt_tokens     integer default 0,
  completion_tokens integer default 0,
  calls             integer not null default 1,
  created_at        timestamptz not null default now()
);

create index llm_usage_user_day_idx on public.llm_usage (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- trigger: updated_at
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'products', 'accounts', 'documents', 'transactions', 'budgets', 'goals'
  ] loop
    execute format(
      'create trigger set_%I_updated_at before update on public.%I
       for each row execute function public.touch_updated_at()', t, t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- trigger: create profile on signup
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
