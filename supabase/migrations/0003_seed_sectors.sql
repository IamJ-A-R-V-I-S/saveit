-- =============================================================================
-- SaveIt — 0003 : seed the FIXED sector taxonomy
-- Sectors are global and stable (they power reporting + budgets). Products
-- live underneath them and are managed per-user by the Analyzer agent.
--
-- Seeded from the real envelope_id structure found in the sample statement:
--   1xxx = food & groceries      2xxx = shopping / home / groceries
--   3xxx = housing / utilities  4xxx = transport (local / ride-hail / trains)
--   5xxx = eating out / drinks / snacks
--   6xxx = health, education, entertainment, gifts, electronics
--   7xxx = telecom / internet   8xxx = loans, fees, meals
--  10xxx = income                11xxx = biryani (speciality dining)
-- =============================================================================

insert into public.sectors (slug, name, icon, description, sort_order) values
  ('groceries',          'Groceries',        '🛒', 'Staples and home cooking supplies',           10),
  ('food_out',           'Eating Out',       '🍽️', 'Restaurants, street food, drinks, snacks',   20),
  ('transport',          'Transport',        '🚕', 'Metro, bus, auto, trains, rides',            30),
  ('housing',            'Housing',          '🏠', 'Rent, maintenance, repairs',                 40),
  ('utilities',          'Bills & Utilities','💡', 'Electricity, water, gas, subscriptions',     50),
  ('telecom',            'Telecom & Internet','📱', 'Recharges, broadband, phone',               60),
  ('shopping',           'Shopping',         '🛍️', 'Clothes, shoes, home goods, electronics',    70),
  ('health',             'Health',           '🏥', 'Medicine, doctor, fitness, wellness',        80),
  ('education',          'Education',        '🎓', 'Fees, courses, books, stationery',           90),
  ('entertainment',      'Entertainment',    '🎬', 'Cinema, events, trips, outings',            100),
  ('loans_transfers',    'Loans & Transfers','💸', 'Lending, repaying, transfers to people',    110),
  ('gifts_social',       'Gifts & Social',   '🎁', 'Charity, gifts, celebrations',              120),
  ('income',             'Income',           '💰', 'Salary, freelance, tuition, refunds',       130),
  ('uncategorized',      'Uncategorized',    '❓', 'Needs review — not yet mapped',             999)
on conflict (slug) do update
  set name        = excluded.name,
      icon        = excluded.icon,
      description = excluded.description,
      sort_order  = excluded.sort_order;
