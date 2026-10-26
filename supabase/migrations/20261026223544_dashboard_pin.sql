begin;
set local lock_timeout='5s';
create table public.cos_dashboard_security (
 id text primary key check(id='owner'),
 pin_hash text,
 pin_version bigint not null default 0,
 failed_attempts integer not null default 0 check(failed_attempts between 0 and 5),
 locked_until timestamptz,
 updated_at timestamptz not null default now()
);
insert into public.cos_dashboard_security(id) values('owner');
create table public.cos_dashboard_pin_sessions (
 session_hash text primary key references public.cos_calendar_sessions(token_hash) on delete cascade,
 unlock_hash text not null check(unlock_hash ~ '^[a-f0-9]{64}$'),
 pin_version bigint not null,
 expires_at timestamptz not null
);
alter table public.cos_dashboard_security enable row level security;
alter table public.cos_dashboard_pin_sessions enable row level security;
revoke all on public.cos_dashboard_security,public.cos_dashboard_pin_sessions from public,anon,authenticated;
grant select,insert,update,delete on public.cos_dashboard_security,public.cos_dashboard_pin_sessions to service_role;

-- Never accept an email or identity supplied by the client.
create function public.cos_dashboard_pin_status(p_session_hash text,p_unlock_hash text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare owner_sub text; owner_email text; settings public.cos_dashboard_security%rowtype; unlocked boolean;
begin
 select google_sub,email into owner_sub,owner_email from public.cos_calendar_connection where id='owner';
 if owner_sub is null then select google_sub,email into owner_sub,owner_email from public.cos_gmail_connection where id='owner'; end if;
 if owner_sub is null or not exists(select 1 from public.cos_calendar_sessions where token_hash=p_session_hash and google_sub=owner_sub and expires_at>now()) then
  return jsonb_build_object('authenticated',false);
 end if;
 select * into strict settings from public.cos_dashboard_security where id='owner';
 select exists(select 1 from public.cos_dashboard_pin_sessions where session_hash=p_session_hash and unlock_hash=p_unlock_hash and pin_version=settings.pin_version and expires_at>now()) into unlocked;
 return jsonb_build_object('authenticated',true,'email',owner_email,'unlocked',unlocked and settings.pin_hash is not null,'setupRequired',settings.pin_hash is null,'retryAfter',greatest(0,ceil(extract(epoch from(settings.locked_until-now())))::integer));
end $$;

-- p_proof is a domain-separated server HMAC. The four-digit PIN never reaches SQL.
-- Locking the singleton serializes setup and failed attempts across all browsers.
create function public.cos_dashboard_pin_unlock(p_session_hash text,p_proof text,p_unlock_hash text,p_setup boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare settings public.cos_dashboard_security%rowtype; state jsonb; attempts integer; until_time timestamptz;
begin
 state:=public.cos_dashboard_pin_status(p_session_hash,null);
 if state->>'authenticated' is distinct from 'true' then return jsonb_build_object('error','unauthorized'); end if;
 if p_proof is null or p_proof !~ '^[a-f0-9]{64}$' or p_unlock_hash is null or p_unlock_hash !~ '^[a-f0-9]{64}$' or p_setup is null then return jsonb_build_object('error','invalid_pin'); end if;
 select * into strict settings from public.cos_dashboard_security where id='owner' for update;
 if settings.locked_until>now() then return jsonb_build_object('error','pin_locked','retryAfter',ceil(extract(epoch from(settings.locked_until-now())))::integer); end if;
 if p_setup then
  if settings.pin_hash is not null then return jsonb_build_object('error','pin_already_configured'); end if;
  update public.cos_dashboard_security set pin_hash=extensions.crypt(p_proof,extensions.gen_salt('bf',12)),pin_version=pin_version+1,failed_attempts=0,locked_until=null,updated_at=now() where id='owner' returning * into settings;
 else
  if settings.pin_hash is null then return jsonb_build_object('error','pin_setup_required'); end if;
  if extensions.crypt(p_proof,settings.pin_hash) is distinct from settings.pin_hash then
   attempts:=case when settings.locked_until is not null then 1 else settings.failed_attempts+1 end;
   until_time:=case when attempts>=5 then now()+interval '15 minutes' else null end;
   update public.cos_dashboard_security set failed_attempts=attempts,locked_until=until_time,updated_at=now() where id='owner';
   -- Return, do not raise: failed-attempt counters must commit.
   return jsonb_build_object('error',case when attempts>=5 then 'pin_locked' else 'pin_incorrect' end,'retryAfter',case when attempts>=5 then 900 else 0 end);
  end if;
  update public.cos_dashboard_security set failed_attempts=0,locked_until=null,updated_at=now() where id='owner';
 end if;
 -- A concurrent logout must not turn into an orphaned unlock.
 if not exists(select 1 from public.cos_calendar_sessions where token_hash=p_session_hash and expires_at>now() for key share) then return jsonb_build_object('error','unauthorized'); end if;
 delete from public.cos_dashboard_pin_sessions where expires_at<=now();
 insert into public.cos_dashboard_pin_sessions(session_hash,unlock_hash,pin_version,expires_at)
 values(p_session_hash,p_unlock_hash,settings.pin_version,now()+interval '12 hours')
 on conflict(session_hash) do update set unlock_hash=excluded.unlock_hash,pin_version=excluded.pin_version,expires_at=excluded.expires_at;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.cos_dashboard_pin_status(text,text),public.cos_dashboard_pin_unlock(text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.cos_dashboard_pin_status(text,text),public.cos_dashboard_pin_unlock(text,text,text,boolean) to service_role;
commit;
