-- The existing app grants writes only through SECURITY DEFINER RPCs.
-- The read-only coach needs SELECT, never direct write access, to these sources.
grant select on public.workout_state, public.nutrition_daily, public.nutrition_goals to service_role;
