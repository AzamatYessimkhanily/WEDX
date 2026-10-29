-- Raw intervals and individual night measurements are retained for future views.
create table public.sleep_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  sample_key text not null check(sample_key ~ '^[a-f0-9]{64}$'),
  metric text not null check(metric in ('sleep','heart_rate','hrv','respiratory_rate','oxygen','wrist_temperature','breathing_disturbances','sleep_goal','apnea_event')),
  start_at timestamptz not null, end_at timestamptz not null,
  local_start text not null, local_end text not null,
  source_name text not null, source_version text not null default '', device text not null default '',
  stage text check(stage in ('in_bed','asleep','awake','core','deep','rem','unknown')),
  value numeric, unit text, raw_value text not null, raw_unit text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  primary key(user_id,sample_key),
  check(end_at>=start_at and end_at<=start_at+case when metric='apnea_event' then interval '90 days' else interval '48 hours' end),
  check((metric='sleep' and stage is not null and value is null and end_at>start_at)
    or (metric<>'sleep' and stage is null and value is not null and unit is not null))
);
create index sleep_samples_time on public.sleep_samples(user_id,start_at,sample_key);
alter table public.sleep_samples enable row level security;
revoke all on public.sleep_samples from anon,authenticated;
grant select on public.sleep_samples to authenticated;
create policy owner_read on public.sleep_samples for select to authenticated using((select auth.uid())=user_id);

create function public.ingest_sleep(p_token_hash text,p_owner uuid,p_samples jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; connection public.integration_tokens; n integer; saved integer:=0; affected integer; pass integer;
begin
  -- Only service_role invokes this function. Browser identity is checked by Auth
  -- in sleep-import; a Shortcut key grants import, never reading private history.
  if p_token_hash is not null then
    select * into connection from public.integration_tokens where token_hash=p_token_hash and source='apple-health' for update;
    u:=connection.user_id;
  else u:=p_owner;
  end if;
  if u is null then raise exception 'Invalid identity' using errcode='28000'; end if;
  if p_samples is null or jsonb_typeof(p_samples)<>'array' then raise exception 'Invalid samples' using errcode='22023'; end if;
  n:=jsonb_array_length(p_samples);
  if n>20000 then raise exception 'Too many samples' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,2));
  if (select count(*) from public.integration_runs where user_id=u and source='sleep:apple-health' and created_at>now()-interval '1 minute')>=120 then
    raise exception 'Too many imports' using errcode='P0001'; end if;
  for pass in 0..1 loop
  insert into public.sleep_samples(user_id,sample_key,metric,start_at,end_at,local_start,local_end,source_name,source_version,device,stage,value,unit,raw_value,raw_unit,metadata)
  select u,r.sample_key,r.metric,r.start_at,r.end_at,r.local_start,r.local_end,r.source_name,r.source_version,r.device,r.stage,r.value,r.unit,r.raw_value,r.raw_unit,r.metadata
  from jsonb_to_recordset(p_samples) as r(sample_key text,metric text,start_at timestamptz,end_at timestamptz,local_start text,local_end text,source_name text,source_version text,device text,stage text,value numeric,unit text,raw_value text,raw_unit text,metadata jsonb)
  where (pass=0 and r.metric='sleep') or (pass=1 and r.metric<>'sleep' and (r.metric in ('sleep_goal','apnea_event') or exists(
    select 1 from public.sleep_samples s where s.user_id=u and s.metric='sleep' and s.source_name=r.source_name
      and s.stage<>'awake' and s.start_at<=r.end_at and s.end_at>=r.start_at)))
  on conflict(user_id,sample_key) do update set stage=excluded.stage,value=excluded.value,unit=excluded.unit,
    local_start=excluded.local_start,local_end=excluded.local_end,
    source_version=coalesce(nullif(excluded.source_version,''),public.sleep_samples.source_version),
    device=coalesce(nullif(excluded.device,''),public.sleep_samples.device),
    raw_value=excluded.raw_value,raw_unit=excluded.raw_unit,metadata=public.sleep_samples.metadata||excluded.metadata,imported_at=now();
  get diagnostics affected = row_count; saved:=saved+affected;
  end loop;
  insert into public.integration_runs(user_id,source,request_id,payload_hash,records) values(u,'sleep:apple-health',gen_random_uuid(),'raw-v1',saved);
  if connection.id is not null then update public.integration_tokens set last_used_at=now() where id=connection.id; end if;
  delete from public.integration_runs where user_id=u and source='sleep:apple-health' and created_at<now()-interval '90 days';
  return jsonb_build_object('status','imported','records',saved);
end $$;
revoke all on function public.ingest_sleep(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_sleep(text,uuid,jsonb) to service_role;
