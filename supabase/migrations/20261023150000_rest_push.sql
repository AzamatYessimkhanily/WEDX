create table public.rest_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.rest_push_timers (
  device_id uuid not null references public.rest_push_devices(id) on delete cascade,
  kind text not null check (kind in ('rest','test')),
  revision bigint not null check (revision > 0 and revision <= 9007199254740991),
  due_at timestamptz not null,
  next_attempt_at timestamptz not null,
  label text not null check (length(label) <= 160),
  status text not null check (status in ('pending','processing','sent','cancelled','expired','failed')),
  attempts integer not null default 0,
  claim_id uuid,
  claimed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (device_id,kind)
);
create index rest_push_due on public.rest_push_timers(next_attempt_at) where status in ('pending','processing');
alter table public.rest_push_devices enable row level security;
alter table public.rest_push_timers enable row level security;
revoke all on public.rest_push_devices,public.rest_push_timers from public,anon,authenticated;
grant all on public.rest_push_devices,public.rest_push_timers to service_role;

-- These RPCs are server-only. The Edge Function validates the user's JWT before
-- passing the owner ID; the browser cannot invoke privileged writes directly.
create function public.register_rest_push(p_user_id uuid,p_endpoint text,p_p256dh text,p_auth text)
returns uuid language plpgsql security definer set search_path='' as $$
declare device public.rest_push_devices;
begin
  perform pg_advisory_xact_lock(hashtextextended('push:'||p_user_id::text,0));
  select * into device from public.rest_push_devices where endpoint=p_endpoint for update;
  if device.id is not null then
    if device.user_id<>p_user_id then raise exception 'Device belongs to another account' using errcode='42501'; end if;
    update public.rest_push_devices set p256dh=p_p256dh,auth_key=p_auth,enabled=true,updated_at=now() where id=device.id;
    return device.id;
  end if;
  if (select count(*) from public.rest_push_devices where user_id=p_user_id and enabled)>=8 then
    raise exception 'Too many devices';
  end if;
  insert into public.rest_push_devices(user_id,endpoint,p256dh,auth_key)
    values(p_user_id,p_endpoint,p_p256dh,p_auth) returning id into device.id;
  return device.id;
end $$;

create function public.schedule_rest_push(p_user_id uuid,p_device_id uuid,p_revision bigint,p_remaining_ms integer,p_label text,p_kind text default 'rest')
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.rest_push_timers; deadline timestamptz; next_status text; current_revision bigint;
begin
  perform 1 from public.rest_push_devices where id=p_device_id and user_id=p_user_id and enabled for update;
  if not found then raise exception 'Device not enabled' using errcode='42501'; end if;
  if p_kind not in ('rest','test') or p_revision is null or p_revision<1 or p_revision>9007199254740991
    or p_label is null or length(p_label)>160 or p_remaining_ms<0 or p_remaining_ms>1800000 then
    raise exception 'Invalid timer' using errcode='22023';
  end if;
  select * into previous from public.rest_push_timers where device_id=p_device_id and kind=p_kind;
  if previous.revision>=p_revision then return jsonb_build_object('accepted',previous.revision=p_revision,'revision',previous.revision); end if;
  if p_kind='test' and previous.updated_at>now()-interval '30 seconds' then raise exception 'Wait before another test'; end if;
  deadline:=now()+coalesce(p_remaining_ms,0)*interval '1 millisecond';
  next_status:=case when p_remaining_ms is null or p_remaining_ms=0 then 'cancelled' else 'pending' end;
  insert into public.rest_push_timers(device_id,kind,revision,due_at,next_attempt_at,label,status)
    values(p_device_id,p_kind,p_revision,deadline,deadline,p_label,next_status)
    on conflict(device_id,kind) do update set revision=excluded.revision,due_at=excluded.due_at,
      next_attempt_at=excluded.next_attempt_at,label=excluded.label,status=excluded.status,
      attempts=0,claim_id=null,claimed_at=null,updated_at=now()
    where public.rest_push_timers.revision<excluded.revision;
  select revision into current_revision from public.rest_push_timers where device_id=p_device_id and kind=p_kind;
  return jsonb_build_object('accepted',current_revision=p_revision,'revision',current_revision,'due_at',deadline);
end $$;

create function public.disable_rest_push(p_user_id uuid,p_device_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.rest_push_devices set enabled=false,updated_at=now() where id=p_device_id and user_id=p_user_id;
  if not found then raise exception 'Device not found' using errcode='42501'; end if;
  update public.rest_push_timers set status='cancelled',updated_at=now() where device_id=p_device_id;
end $$;

create function public.claim_rest_push()
returns table(device_id uuid,kind text,revision bigint,claim_id uuid,due_at timestamptz,label text,endpoint text,p256dh text,auth_key text)
language plpgsql security definer set search_path='' as $$
begin
  update public.rest_push_timers t set status='expired',updated_at=now()
    where t.status in ('pending','processing') and t.due_at<now()-interval '90 seconds';
  return query
  with due as (
    select t.device_id,t.kind from public.rest_push_timers t
    join public.rest_push_devices d on d.id=t.device_id and d.enabled
    where t.due_at<=now() and t.attempts<3 and
      ((t.status='pending' and t.next_attempt_at<=now()) or (t.status='processing' and t.claimed_at<now()-interval '25 seconds'))
    order by t.due_at for update of t skip locked limit 20
  ), claimed as (
    update public.rest_push_timers t set status='processing',claim_id=gen_random_uuid(),claimed_at=now(),attempts=t.attempts+1
    from due where t.device_id=due.device_id and t.kind=due.kind returning t.*
  ) select c.device_id,c.kind,c.revision,c.claim_id,c.due_at,c.label,d.endpoint,d.p256dh,d.auth_key
    from claimed c join public.rest_push_devices d on d.id=c.device_id;
end $$;

create function public.rest_push_current(p_device_id uuid,p_kind text,p_revision bigint,p_claim_id uuid)
returns boolean language sql security definer set search_path='' as $$
  select exists(select 1 from public.rest_push_timers t join public.rest_push_devices d on d.id=t.device_id
    where t.device_id=p_device_id and t.kind=p_kind and t.revision=p_revision and t.claim_id=p_claim_id
      and t.status='processing' and t.due_at>now()-interval '90 seconds' and d.enabled);
$$;

create function public.finish_rest_push(p_device_id uuid,p_kind text,p_revision bigint,p_claim_id uuid,p_result text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_result not in ('sent','retry','gone','failed') then raise exception 'Invalid result'; end if;
  update public.rest_push_timers set status=case when p_result='retry' and attempts<3 then 'pending'
      when p_result='sent' then 'sent' else 'failed' end,
    next_attempt_at=now()+interval '5 seconds',updated_at=now()
    where device_id=p_device_id and kind=p_kind and revision=p_revision and claim_id=p_claim_id and status='processing';
  if found and p_result='gone' then
    update public.rest_push_devices set enabled=false,updated_at=now() where id=p_device_id;
    update public.rest_push_timers set status='cancelled' where device_id=p_device_id and status in ('pending','processing');
  end if;
end $$;

create function public.rest_push_credentials()
returns jsonb language plpgsql security definer set search_path='' as $$
declare credentials jsonb;
begin
  select decrypted_secret::jsonb into credentials from vault.decrypted_secrets where name='wedx_rest_push';
  return credentials;
end $$;

revoke all on function public.register_rest_push(uuid,text,text,text),public.schedule_rest_push(uuid,uuid,bigint,integer,text,text),
  public.disable_rest_push(uuid,uuid),public.claim_rest_push(),public.rest_push_current(uuid,text,bigint,uuid),
  public.finish_rest_push(uuid,text,bigint,uuid,text),public.rest_push_credentials() from public,anon,authenticated;
grant execute on function public.register_rest_push(uuid,text,text,text),public.schedule_rest_push(uuid,uuid,bigint,integer,text,text),
  public.disable_rest_push(uuid,uuid),public.claim_rest_push(),public.rest_push_current(uuid,text,bigint,uuid),
  public.finish_rest_push(uuid,text,bigint,uuid,text),public.rest_push_credentials() to service_role;
