-- Nullable means unavailable, never zero. Old shortcuts remain valid.
alter table public.nutrition_daily
  add column carbs_grams numeric check (carbs_grams between 0 and 10000),
  add column fat_grams numeric check (fat_grams between 0 and 10000),
  add column calories_burned numeric check (calories_burned between 0 and 100000),
  add column activity_status text not null default 'unknown'
    check (activity_status in ('unknown','verified','no_data','multiple_sources','overlap')),
  add column metric_synced_at jsonb not null default '{}'::jsonb,
  add constraint verified_activity check ((activity_status = 'verified' and calories_burned is not null)
    or (activity_status <> 'verified' and calories_burned is null));
update public.nutrition_daily set metric_synced_at=jsonb_build_object('calories',updated_at,'protein',updated_at);

-- Health does not export YAZIO goals. These are explicit WEDX settings with
-- effective dates; a new target never silently rewrites earlier days.
create table public.nutrition_goals (
  user_id uuid not null references auth.users(id) on delete cascade,
  effective_from date not null,
  base_calorie_goal numeric not null check (base_calorie_goal > 0 and base_calorie_goal <= 100000),
  protein_goal_g numeric not null check (protein_goal_g > 0 and protein_goal_g <= 10000),
  include_activity boolean not null default false,
  source text not null default 'manual' check (source = 'manual'),
  updated_at timestamptz not null default now(),
  primary key (user_id,effective_from)
);
alter table public.nutrition_goals enable row level security;
revoke all on public.nutrition_goals from anon,authenticated;
grant select,insert,update on public.nutrition_goals to authenticated;
create policy owner_read on public.nutrition_goals for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on public.nutrition_goals for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on public.nutrition_goals for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.ingest_nutrition(p_token_hash text,p_request_id uuid,p_payload_hash text,p_days jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  connection public.integration_tokens; previous public.integration_runs; d jsonb; count_days integer;
begin
  select * into connection from public.integration_tokens where token_hash=p_token_hash and source='apple-health' for update;
  if connection.id is null then raise exception 'Invalid integration token' using errcode='28000'; end if;
  if p_request_id is null or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_days is null or jsonb_typeof(p_days) <> 'array' then
    raise exception 'Invalid import' using errcode='22023';
  end if;
  count_days := jsonb_array_length(p_days);
  if count_days < 1 or count_days > 31 then raise exception 'Expected 1 to 31 days' using errcode='22023'; end if;
  -- Serialize all tokens for one owner: deduplication and rate limits are atomic.
  perform pg_advisory_xact_lock(hashtextextended(connection.user_id::text, 1));
  select * into previous from public.integration_runs where user_id=connection.user_id and source='yazio:apple-health' and request_id=p_request_id;
  if previous.request_id is not null then
    if previous.payload_hash <> p_payload_hash then raise exception 'Request id reused with another payload' using errcode='23505'; end if;
    return jsonb_build_object('status','duplicate','records',previous.records);
  end if;
  if (select count(*) from public.integration_runs where user_id=connection.user_id and created_at > now()-interval '1 minute') >= 30 then
    raise exception 'Too many imports' using errcode='P0001';
  end if;
  if (select count(distinct value->>'date') from jsonb_array_elements(p_days)) <> count_days then
    raise exception 'Duplicate dates' using errcode='22023';
  end if;
  for d in select value from jsonb_array_elements(p_days) loop
    if jsonb_typeof(d) <> 'object' or (d->>'date') is null or (d->>'date') !~ '^\d{4}-\d{2}-\d{2}$'
      or jsonb_typeof(d->'caloriesKcal') is distinct from 'number' or jsonb_typeof(d->'proteinGrams') is distinct from 'number' then
      raise exception 'Invalid nutrition row' using errcode='22023';
    end if;
    if (d ? 'carbsGrams' and jsonb_typeof(d->'carbsGrams') is distinct from 'number')
      or (d ? 'fatGrams' and jsonb_typeof(d->'fatGrams') is distinct from 'number')
      or (d ? 'activityStatus' and (
        coalesce(d->>'activityStatus','') not in ('verified','no_data','multiple_sources','overlap')
        or ((d->>'activityStatus') = 'verified' and jsonb_typeof(d->'caloriesBurned') is distinct from 'number')
        or ((d->>'activityStatus') <> 'verified' and d->'caloriesBurned' is distinct from 'null'::jsonb))) then
      raise exception 'Invalid additional metrics' using errcode='22023';
    end if;
    insert into public.nutrition_daily(user_id,source,day,calories_kcal,protein_grams,carbs_grams,fat_grams,
      calories_burned,activity_status,metric_synced_at)
      values(connection.user_id,'yazio:apple-health',(d->>'date')::date,(d->>'caloriesKcal')::numeric,(d->>'proteinGrams')::numeric,
        (d->>'carbsGrams')::numeric,(d->>'fatGrams')::numeric,(d->>'caloriesBurned')::numeric,
        coalesce(d->>'activityStatus','unknown'),
        jsonb_build_object('calories',now(),'protein',now())
        || case when d ? 'carbsGrams' then jsonb_build_object('carbs',now()) else '{}'::jsonb end
        || case when d ? 'fatGrams' then jsonb_build_object('fat',now()) else '{}'::jsonb end
        || case when d ? 'activityStatus' then jsonb_build_object('activity',now()) else '{}'::jsonb end)
      on conflict(user_id,source,day) do update set
        calories_kcal=excluded.calories_kcal,protein_grams=excluded.protein_grams,
        carbs_grams=coalesce(excluded.carbs_grams,public.nutrition_daily.carbs_grams),
        fat_grams=coalesce(excluded.fat_grams,public.nutrition_daily.fat_grams),
        calories_burned=case when d ? 'activityStatus' then excluded.calories_burned else public.nutrition_daily.calories_burned end,
        activity_status=case when d ? 'activityStatus' then excluded.activity_status else public.nutrition_daily.activity_status end,
        metric_synced_at=public.nutrition_daily.metric_synced_at || excluded.metric_synced_at,updated_at=now();
  end loop;
  insert into public.integration_runs(user_id,source,request_id,payload_hash,records)
    values(connection.user_id,'yazio:apple-health',p_request_id,p_payload_hash,count_days);
  update public.integration_tokens set last_used_at=now() where id=connection.id;
  -- Bound metadata growth on the free plan; daily totals still upsert after this window.
  delete from public.integration_runs where user_id=connection.user_id and created_at < now()-interval '90 days';
  return jsonb_build_object('status','imported','records',count_days);
end $$;
revoke all on function public.ingest_nutrition(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_nutrition(text,uuid,text,jsonb) to service_role;
