-- OAuth credentials are scoped exclusively to the read-only WEDX coach.
-- These opaque tokens cannot authenticate to Supabase Auth or the app's write APIs.
create table public.coach_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  goal text check (length(goal)<=500),
  timezone text not null default 'Asia/Almaty',
  updated_at timestamptz not null default now()
);
create table public.coach_pairing_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now()+interval '10 minutes',
  created_at timestamptz not null default now()
);
create table public.coach_oauth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  redirect_uri text not null,
  resource text not null,
  state text not null check (length(state) between 1 and 2000),
  challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  openid boolean not null default false,
  nonce text check (length(nonce)<=500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '10 minutes',
  user_id uuid references auth.users(id) on delete cascade,
  code_hash text unique,
  status text not null default 'pending' check (status in ('pending','approved','consumed','denied'))
);
create table public.coach_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  resource text not null,
  scope text not null default 'wedx:read' check (scope='wedx:read'),
  openid boolean not null default false,
  access_hash text not null unique check (access_hash ~ '^[a-f0-9]{64}$'),
  refresh_hash text not null unique check (refresh_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz not null default now()+interval '1 hour',
  refresh_expires_at timestamptz not null default now()+interval '90 days',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  window_at timestamptz not null default now(),
  window_calls integer not null default 0
);
create table public.coach_used_refresh_tokens (
  token_hash text primary key,
  grant_id uuid not null references public.coach_oauth_grants(id) on delete cascade,
  expires_at timestamptz not null
);
do $$ declare t text; begin
  foreach t in array array['coach_preferences','coach_pairing_codes','coach_oauth_requests','coach_oauth_grants','coach_used_refresh_tokens'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

create function public.coach_begin_authorization(p_client text,p_redirect text,p_resource text,p_state text,p_challenge text,p_openid boolean default false,p_nonce text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare request_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('wedx-coach-auth',0));
  delete from public.coach_oauth_requests where expires_at<now();
  delete from public.coach_pairing_codes where expires_at<now();
  delete from public.coach_used_refresh_tokens where expires_at<now();
  if (select count(*) from public.coach_oauth_requests where created_at>now()-interval '1 minute')>=60 then
    raise exception 'Too many requests' using errcode='P0001';
  end if;
  insert into public.coach_oauth_requests(client_id,redirect_uri,resource,state,challenge,openid,nonce)
    values(p_client,p_redirect,p_resource,p_state,p_challenge,p_openid,p_nonce) returning id into request_id;
  return request_id;
end $$;

create function public.coach_create_pairing(p_user_id uuid,p_hash text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('coach-pair:'||p_user_id::text,0));
  if (select count(*) from public.coach_pairing_codes where user_id=p_user_id and created_at>now()-interval '1 minute')>=10 then
    raise exception 'Too many requests' using errcode='P0001';
  end if;
  delete from public.coach_pairing_codes where user_id=p_user_id and expires_at<now();
  insert into public.coach_pairing_codes(code_hash,user_id) values(p_hash,p_user_id);
end $$;

create function public.coach_approve_authorization(p_request uuid,p_user_id uuid,p_pairing_hash text,p_code_hash text,p_deny boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.coach_oauth_requests; owner uuid:=p_user_id;
begin
  select * into req from public.coach_oauth_requests where id=p_request for update;
  if req.id is null or req.status<>'pending' or req.expires_at<=now() then return jsonb_build_object('error','invalid_request'); end if;
  if not p_deny then
    if owner is null then
      delete from public.coach_pairing_codes where code_hash=p_pairing_hash and expires_at>now() returning user_id into owner;
    end if;
    if owner is null then return jsonb_build_object('error','invalid_pairing_code'); end if;
    if p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid code'; end if;
  end if;
  update public.coach_oauth_requests set user_id=owner,code_hash=case when p_deny then null else p_code_hash end,
    status=case when p_deny then 'denied' else 'approved' end,expires_at=now()+interval '2 minutes' where id=req.id;
  return jsonb_build_object('redirect_uri',req.redirect_uri,'state',req.state);
end $$;

create function public.coach_exchange_code(p_hash text,p_client text,p_redirect text,p_resource text,p_challenge text,p_access_hash text,p_refresh_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.coach_oauth_requests; grant_id uuid;
begin
  select * into req from public.coach_oauth_requests where code_hash=p_hash for update;
  if p_client is null or p_redirect is null or p_resource is null or p_challenge is null
    or req.id is null or req.status<>'approved' or req.expires_at<=now() or req.client_id<>p_client
    or req.redirect_uri<>p_redirect or req.resource<>p_resource or req.challenge<>p_challenge then
    return jsonb_build_object('error','invalid_grant');
  end if;
  update public.coach_oauth_requests set status='consumed' where id=req.id;
  insert into public.coach_oauth_grants(user_id,client_id,resource,access_hash,refresh_hash,openid)
    values(req.user_id,req.client_id,req.resource,p_access_hash,p_refresh_hash,req.openid) returning id into grant_id;
  return jsonb_build_object('grant_id',grant_id,'user_id',req.user_id,'openid',req.openid,'nonce',req.nonce);
end $$;

create function public.coach_refresh_token(p_hash text,p_client text,p_resource text,p_access_hash text,p_refresh_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.coach_oauth_grants; old_grant uuid;
begin
  -- Lock even expired/revoked rows; concurrent refresh cannot mint two replacements.
  select * into g from public.coach_oauth_grants where refresh_hash=p_hash for update;
  if g.id is null then
    select grant_id into old_grant from public.coach_used_refresh_tokens where token_hash=p_hash;
    if old_grant is not null then update public.coach_oauth_grants set revoked_at=coalesce(revoked_at,now()) where id=old_grant and client_id=p_client; end if;
    return jsonb_build_object('error','invalid_grant');
  end if;
  if p_client is null or p_resource is null or g.revoked_at is not null or g.refresh_expires_at<=now() or g.client_id<>p_client or g.resource<>p_resource then
    return jsonb_build_object('error','invalid_grant');
  end if;
  insert into public.coach_used_refresh_tokens values(g.refresh_hash,g.id,g.refresh_expires_at);
  update public.coach_oauth_grants set access_hash=p_access_hash,refresh_hash=p_refresh_hash,
    access_expires_at=now()+interval '1 hour',refresh_expires_at=now()+interval '90 days' where id=g.id;
  return jsonb_build_object('grant_id',g.id,'user_id',g.user_id,'openid',g.openid);
end $$;

create function public.coach_read_access(p_hash text,p_resource text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.coach_oauth_grants;
begin
  select * into g from public.coach_oauth_grants where access_hash=p_hash for update;
  if p_resource is null or g.id is null or g.revoked_at is not null or g.access_expires_at<=now() or g.resource<>p_resource or g.scope<>'wedx:read' then
    return jsonb_build_object('error','invalid_token');
  end if;
  if g.window_at>now()-interval '1 minute' and g.window_calls>=120 then return jsonb_build_object('error','rate_limited'); end if;
  update public.coach_oauth_grants set last_used_at=now(),window_at=case when g.window_at<=now()-interval '1 minute' then now() else g.window_at end,
    window_calls=case when g.window_at<=now()-interval '1 minute' then 1 else g.window_calls+1 end where id=g.id;
  return jsonb_build_object('user_id',g.user_id,'grant_id',g.id,'openid',g.openid);
end $$;

create function public.coach_signing_key()
returns jsonb language plpgsql security definer set search_path='' as $$
declare credentials jsonb;
begin
  select decrypted_secret::jsonb into credentials from vault.decrypted_secrets where name='wedx_coach_oidc';
  return credentials;
end $$;

revoke all on function public.coach_begin_authorization(text,text,text,text,text,boolean,text),public.coach_create_pairing(uuid,text),public.coach_signing_key(),
  public.coach_approve_authorization(uuid,uuid,text,text,boolean),public.coach_exchange_code(text,text,text,text,text,text,text),
  public.coach_refresh_token(text,text,text,text,text),public.coach_read_access(text,text) from public,anon,authenticated;
grant execute on function public.coach_begin_authorization(text,text,text,text,text,boolean,text),public.coach_create_pairing(uuid,text),public.coach_signing_key(),
  public.coach_approve_authorization(uuid,uuid,text,text,boolean),public.coach_exchange_code(text,text,text,text,text,text,text),
  public.coach_refresh_token(text,text,text,text,text),public.coach_read_access(text,text) to service_role;
