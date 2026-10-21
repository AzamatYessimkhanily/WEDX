-- The snapshot is a compatibility/write model for the existing workout editor.
-- Relational projections are rebuilt atomically for queries and future clients.
create table public.workout_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  updated_at timestamptz not null default now()
);
create table public.workout_backups (
  user_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, revision)
);
create table public.gyms (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null,
  primary key (user_id, id)
);
create table public.workout_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  program_day text not null,
  gym_id text,
  started_at_ms bigint,
  ended_at_ms bigint,
  primary key (user_id, day)
);
create table public.exercise_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_key text not null,
  day date not null,
  ordinal integer not null,
  gym_id text,
  best_weight numeric not null check (best_weight >= 0),
  best_reps numeric not null check (best_reps >= 0),
  volume numeric not null check (volume >= 0),
  set_count integer not null check (set_count >= 0),
  primary key (user_id, exercise_key, day, ordinal)
);
create table public.exercise_sets (
  user_id uuid not null,
  exercise_key text not null,
  day date not null,
  ordinal integer not null,
  set_index integer not null,
  weight numeric not null check (weight >= 0),
  reps numeric not null check (reps >= 0),
  extra_weight numeric,
  extra_reps numeric,
  primary key (user_id, exercise_key, day, ordinal, set_index),
  foreign key (user_id, exercise_key, day, ordinal)
    references public.exercise_history(user_id, exercise_key, day, ordinal) on delete cascade
);
create table public.body_measurements (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  weight_kg numeric not null check (weight_kg >= 0),
  primary key (user_id, day)
);
create table public.integration_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 100),
  source text not null check (source = 'apple-health'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index integration_tokens_owner on public.integration_tokens(user_id);
create table public.nutrition_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source = 'yazio:apple-health'),
  day date not null,
  calories_kcal numeric not null check (calories_kcal between 0 and 100000),
  protein_grams numeric not null check (protein_grams between 0 and 10000),
  updated_at timestamptz not null default now(),
  primary key (user_id, source, day)
);
create table public.integration_runs (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  request_id uuid not null,
  payload_hash text not null,
  records integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, source, request_id)
);
create index integration_runs_recent on public.integration_runs(user_id, created_at);

-- Authenticated clients may only read their rows. Writes use bounded RPCs.
do $$
declare t text;
begin
  foreach t in array array['workout_state','workout_backups','gyms','workout_sessions',
    'exercise_history','exercise_sets','body_measurements','integration_tokens','nutrition_daily','integration_runs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;
grant insert (user_id,label,source,token_hash), delete on public.integration_tokens to authenticated;
create policy owner_create on public.integration_tokens for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_revoke on public.integration_tokens for delete to authenticated using ((select auth.uid()) = user_id);

create function public.save_workout_state(p_snapshot jsonb, p_expected_revision bigint, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid(); old public.workout_state; next_revision bigint;
  e record; r record; s record; g jsonb; b jsonb;
begin
  if u is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_user_id is distinct from u then raise exception 'Account changed' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_snapshot is null
    or jsonb_typeof(p_snapshot) <> 'object' or jsonb_typeof(p_snapshot->'hist') is distinct from 'object'
    or octet_length(p_snapshot::text) > 5000000 then
    raise exception 'Invalid workout state' using errcode = '22023';
  end if;
  -- Serializes first insert and later writes for the same owner.
  perform pg_advisory_xact_lock(hashtextextended(u::text, 0));
  select * into old from public.workout_state where user_id = u;
  if coalesce(old.revision, 0) <> p_expected_revision then
    return jsonb_build_object('status','conflict','revision',old.revision);
  end if;
  next_revision := coalesce(old.revision, 0) + 1;
  if old.revision is not null then
    insert into public.workout_backups(user_id,revision,snapshot) values(u,old.revision,old.snapshot);
    delete from public.workout_backups where user_id=u and revision <= next_revision - 21;
  end if;
  insert into public.workout_state(user_id,revision,snapshot) values(u,next_revision,p_snapshot)
    on conflict(user_id) do update set revision=excluded.revision,snapshot=excluded.snapshot,updated_at=now();
  delete from public.exercise_history where user_id=u;
  delete from public.workout_sessions where user_id=u;
  delete from public.gyms where user_id=u;
  delete from public.body_measurements where user_id=u;
  for g in select value from jsonb_array_elements(coalesce(p_snapshot->'gyms','[]')) loop
    insert into public.gyms values(u,g->>'id',g->>'n');
  end loop;
  for e in select * from jsonb_each(coalesce(p_snapshot->'sess','{}')) loop
    insert into public.workout_sessions values(u,e.key::date,e.value->>'day',e.value->>'g',
      (e.value->>'t0')::bigint,(e.value->>'t1')::bigint);
  end loop;
  for e in select * from jsonb_each(p_snapshot->'hist') loop
    for r in select value, ordinality from jsonb_array_elements(e.value) with ordinality loop
      insert into public.exercise_history values(u,e.key,(r.value->>'d')::date,r.ordinality,
        r.value->>'g',(r.value->>'w')::numeric,(r.value->>'r')::numeric,(r.value->>'v')::numeric,(r.value->>'n')::integer);
      -- Old aggregate-only history remains aggregate-only; never invent individual sets.
      for s in select value, ordinality from jsonb_array_elements(coalesce(r.value->'s','[]')) with ordinality loop
        if s.value <> 'null'::jsonb then
          insert into public.exercise_sets values(u,e.key,(r.value->>'d')::date,r.ordinality,s.ordinality,
            (s.value->>0)::numeric,(s.value->>1)::numeric,(s.value->>2)::numeric,(s.value->>3)::numeric);
        end if;
      end loop;
    end loop;
  end loop;
  for b in select value from jsonb_array_elements(coalesce(p_snapshot->'bw','[]')) loop
    insert into public.body_measurements values(u,(b->>'d')::date,(b->>'w')::numeric);
  end loop;
  return jsonb_build_object('status','saved','revision',next_revision);
end $$;
revoke all on function public.save_workout_state(jsonb,bigint,uuid) from public, anon;
grant execute on function public.save_workout_state(jsonb,bigint,uuid) to authenticated;

-- Only the Edge Function can invoke this operation with its server-side service role.
-- The token grants nutrition import, never workout reading or editing.
create function public.ingest_nutrition(p_token_hash text,p_request_id uuid,p_payload_hash text,p_days jsonb)
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
    insert into public.nutrition_daily(user_id,source,day,calories_kcal,protein_grams)
      values(connection.user_id,'yazio:apple-health',(d->>'date')::date,(d->>'caloriesKcal')::numeric,(d->>'proteinGrams')::numeric)
      on conflict(user_id,source,day) do update set calories_kcal=excluded.calories_kcal,protein_grams=excluded.protein_grams,updated_at=now();
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
