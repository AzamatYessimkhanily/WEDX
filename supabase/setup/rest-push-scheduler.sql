-- Hosted Postgres only: run after the core migration, Vault secret and Edge deployment.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_rest_push()
returns void language plpgsql security definer set search_path='' as $$
declare config jsonb;
begin
  -- No HTTP calls when no timers are due. Normal rest periods cost one Edge
  -- invocation at expiry, not one invocation per scheduler tick.
  if not exists(select 1 from public.rest_push_timers t join public.rest_push_devices d on d.id=t.device_id
    where d.enabled and t.due_at<=now() and (t.status='pending' and t.next_attempt_at<=now()
      or t.status='processing' and t.claimed_at<now()-interval '25 seconds')) then return; end if;
  config:=public.rest_push_credentials();
  if config->>'dispatchSecret' is null then return; end if;
  perform net.http_post(url:=config->>'dispatchUrl',
    headers:=jsonb_build_object('Content-Type','application/json','X-WEDX-Dispatch',config->>'dispatchSecret'),
    body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=15000);
end $$;
revoke all on function public.dispatch_rest_push() from public,anon,authenticated,service_role;
select cron.schedule('wedx-rest-push','5 seconds','select public.dispatch_rest_push()');
select cron.schedule('wedx-rest-push-cleanup','17 3 * * *',
  $$delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname in ('wedx-rest-push','wedx-rest-push-cleanup')) and end_time<now()-interval '2 days'$$);
