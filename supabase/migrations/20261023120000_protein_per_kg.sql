-- Dated, adjustable protein target based on the last body-weight measurement
-- available on that day. Keep the previous fixed gram goals for compatibility.
alter table public.nutrition_goals
  add column protein_per_kg numeric not null default 2
  check (protein_per_kg between 0.5 and 3.5);
