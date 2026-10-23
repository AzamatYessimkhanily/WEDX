-- Native Health daily totals replace raw-record loops. Keep the legacy source
-- key to update existing history instead of creating a second row for each day.
alter table public.nutrition_daily
  add column nutrition_origin text not null default 'yazio' check (nutrition_origin in ('yazio','apple-health')),
  drop constraint nutrition_daily_activity_status_check,
  drop constraint verified_activity,
  add constraint nutrition_daily_activity_status_check check (activity_status in ('unknown','verified','health_total','no_data','multiple_sources','overlap')),
  add constraint verified_activity check ((activity_status in ('verified','health_total') and calories_burned is not null)
    or (activity_status not in ('verified','health_total') and calories_burned is null));
-- Protein targets are outside the seven requested metrics. Existing values remain.
alter table public.nutrition_goals alter column protein_goal_g drop not null;

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
        coalesce(d->>'activityStatus','') not in ('verified','health_total','no_data','multiple_sources','overlap')
        or ((d->>'activityStatus') in ('verified','health_total') and jsonb_typeof(d->'caloriesBurned') is distinct from 'number')
        or ((d->>'activityStatus') not in ('verified','health_total') and d->'caloriesBurned' is distinct from 'null'::jsonb))) then
      raise exception 'Invalid additional metrics' using errcode='22023';
    end if;
    if d ? 'nutritionOrigin' and coalesce(d->>'nutritionOrigin','') not in ('yazio','apple-health') then
      raise exception 'Invalid nutrition origin' using errcode='22023';
    end if;
    insert into public.nutrition_daily(user_id,source,day,calories_kcal,protein_grams,carbs_grams,fat_grams,
      calories_burned,activity_status,nutrition_origin,metric_synced_at)
      values(connection.user_id,'yazio:apple-health',(d->>'date')::date,(d->>'caloriesKcal')::numeric,(d->>'proteinGrams')::numeric,
        (d->>'carbsGrams')::numeric,(d->>'fatGrams')::numeric,(d->>'caloriesBurned')::numeric,
        coalesce(d->>'activityStatus','unknown'),coalesce(d->>'nutritionOrigin','yazio'),
        jsonb_build_object('calories',now(),'protein',now())
        || case when d ? 'carbsGrams' then jsonb_build_object('carbs',now()) else '{}'::jsonb end
        || case when d ? 'fatGrams' then jsonb_build_object('fat',now()) else '{}'::jsonb end
        || case when d ? 'activityStatus' then jsonb_build_object('activity',now()) else '{}'::jsonb end)
      on conflict(user_id,source,day) do update set
        calories_kcal=excluded.calories_kcal,protein_grams=excluded.protein_grams,nutrition_origin=excluded.nutrition_origin,
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
