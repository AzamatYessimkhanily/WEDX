-- Supabase's optional automatic-RLS event trigger is administrative only.
-- PostgreSQL can still invoke it as an event trigger after these revocations.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
