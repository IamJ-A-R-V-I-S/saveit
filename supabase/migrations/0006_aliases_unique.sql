-- =============================================================================
-- SaveIt — 0006 : unique constraint for learned alias rules
--
-- The categorize function upserts an alias after every confident
-- categorization, using onConflict: 'user_id,pattern'. Without a matching unique
-- index that upsert silently degrades into repeated inserts, and the alias table
-- fills with duplicates -- which then makes resolveDeterministic() slower on
-- every subsequent import, forever.
--
-- user_id is nullable (global rules). Postgres treats NULLs as distinct in a
-- unique index, so global aliases are not constrained by this. That is
-- acceptable: globals are seeded by migrations, not written at runtime.
-- =============================================================================

-- Clear any duplicates that already exist before constraining, so the index
-- build cannot fail.
delete from public.aliases a
using public.aliases b
where a.ctid < b.ctid
  and a.user_id is not distinct from b.user_id
  and a.pattern = b.pattern;

create unique index if not exists aliases_user_pattern_uidx
  on public.aliases (user_id, pattern);

-- resolveDeterministic() sorts aliases by pattern length and tests `contains`
-- against a lowercased description. A functional index on the folded pattern
-- keeps that lookup cheap as the table grows into the thousands.
create index if not exists aliases_lower_pattern_idx
  on public.aliases (lower(pattern));
