-- Idempotent deployment script; execute as the database owner with Supabase
-- Vault enabled. No credentials, cron jobs, connections or Google calls here.
-- Provision one JSON secret named cos_calendar_config separately in Vault.
begin;

-- This schema is not part of the public Data API schema list.
create schema if not exists cos_calendar_private;
revoke all privileges on schema cos_calendar_private from public, anon, authenticated;
grant usage on schema cos_calendar_private to service_role;

create table if not exists public.cos_calendar_connection (
  id text primary key default 'owner' check (id = 'owner'),
  connection_key uuid not null default gen_random_uuid(),
  google_sub text,
  email text,
  calendar_id text,
  time_zone text,
  refresh_token_cipher text,
  status text not null default 'disconnected'
    check (status in ('connected', 'disconnected', 'needs_reconnect', 'provisioning')),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cos_calendar_oauth_states (
  state_hash text primary key,
  browser_hash text not null,
  verifier text not null,
  time_zone text not null,
  expires_at timestamptz not null
);

create table if not exists public.cos_calendar_sessions (
  token_hash text primary key,
  google_sub text not null,
  expires_at timestamptz not null
);

create table if not exists public.cos_calendar_bindings (
  connection_key uuid not null,
  source_kind text not null,
  source_id uuid not null,
  generation integer not null default 0 check (generation >= 0),
  event_id text,
  state text not null default 'pending',
  source_hash text,
  last_error text,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  pending_operation text,
  primary key (connection_key, source_kind, source_id)
);

-- These nullable additions also update an earlier deployment of this script.
alter table public.cos_calendar_bindings add column if not exists last_attempt_at timestamptz;
alter table public.cos_calendar_bindings add column if not exists pending_operation text;
alter table public.cos_calendar_bindings drop constraint if exists cos_calendar_bindings_state_check;
alter table public.cos_calendar_bindings add constraint cos_calendar_bindings_state_check
  check (state in ('pending', 'active', 'deleted', 'conflict', 'error'));
alter table public.cos_calendar_bindings drop constraint if exists cos_calendar_bindings_pending_operation_check;
alter table public.cos_calendar_bindings add constraint cos_calendar_bindings_pending_operation_check
  check (pending_operation is null or pending_operation in ('create', 'update', 'delete'));

create table if not exists public.cos_calendar_lock (
  id text primary key default 'owner' check (id = 'owner'),
  holder text not null,
  expires_at timestamptz not null
);

create index if not exists cos_calendar_oauth_states_expires_idx
  on public.cos_calendar_oauth_states (expires_at);
create index if not exists cos_calendar_sessions_expires_idx
  on public.cos_calendar_sessions (expires_at);
create index if not exists cos_calendar_bindings_attempt_idx
  on public.cos_calendar_bindings (connection_key, last_attempt_at nulls first, source_kind, source_id);

alter table public.cos_calendar_connection enable row level security;
alter table public.cos_calendar_connection force row level security;
alter table public.cos_calendar_oauth_states enable row level security;
alter table public.cos_calendar_oauth_states force row level security;
alter table public.cos_calendar_sessions enable row level security;
alter table public.cos_calendar_sessions force row level security;
alter table public.cos_calendar_bindings enable row level security;
alter table public.cos_calendar_bindings force row level security;
alter table public.cos_calendar_lock enable row level security;
alter table public.cos_calendar_lock force row level security;

revoke all privileges on table
  public.cos_calendar_connection,
  public.cos_calendar_oauth_states,
  public.cos_calendar_sessions,
  public.cos_calendar_bindings,
  public.cos_calendar_lock
from public, anon, authenticated;
grant select, insert, update, delete on table
  public.cos_calendar_connection,
  public.cos_calendar_oauth_states,
  public.cos_calendar_sessions,
  public.cos_calendar_bindings,
  public.cos_calendar_lock
to service_role;

create or replace function public.cos_calendar_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;
revoke all privileges on function public.cos_calendar_touch_updated_at() from public, anon, authenticated;
grant execute on function public.cos_calendar_touch_updated_at() to service_role;
drop trigger if exists cos_calendar_connection_updated_at on public.cos_calendar_connection;
create trigger cos_calendar_connection_updated_at
before update on public.cos_calendar_connection
for each row execute function public.cos_calendar_touch_updated_at();

-- The only SECURITY DEFINER function lives outside exposed schemas. It reads
-- one Vault secret; the service role has no general decrypted_secrets grant.
create or replace function cos_calendar_private.get_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  request_role text;
  secret_text text;
  config jsonb;
begin
  request_role := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  if request_role <> 'service_role' then
    raise exception using errcode = '42501', message = 'Calendar configuration is restricted to the service role.';
  end if;
  select decrypted_secret into secret_text
    from vault.decrypted_secrets
    where name = 'cos_calendar_config';
  if secret_text is null then
    raise exception using errcode = 'P0001', message = 'Calendar server configuration has not been provisioned.';
  end if;
  begin
    config := secret_text::jsonb;
  exception when invalid_text_representation then
    -- A cast error normally includes secret contents in DETAIL; suppress it.
    raise exception using errcode = 'P0001', message = 'Calendar server configuration is invalid.';
  end;
  if pg_catalog.jsonb_typeof(config) <> 'object' then
    raise exception using errcode = 'P0001', message = 'Calendar server configuration must be a JSON object.';
  end if;
  return config;
end;
$function$;
revoke all privileges on function cos_calendar_private.get_config() from public, anon, authenticated;
grant execute on function cos_calendar_private.get_config() to service_role;

-- Keep the backend's public RPC name, without exposing a definer function.
create or replace function public.cos_calendar_get_config()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select cos_calendar_private.get_config();
$function$;
revoke all privileges on function public.cos_calendar_get_config() from public, anon, authenticated;
grant execute on function public.cos_calendar_get_config() to service_role;

-- INSERT .. ON CONFLICT .. WHERE is a single atomic claim. An unexpired
-- holder (including the same holder) cannot be replaced or silently renewed.
create or replace function public.cos_calendar_claim_lock(p_holder text, p_seconds integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  affected integer;
  claim_time timestamptz := pg_catalog.clock_timestamp();
begin
  if p_holder is null or pg_catalog.btrim(p_holder) = '' or pg_catalog.length(p_holder) > 200
      or p_seconds is null or p_seconds < 1 or p_seconds > 3600 then
    raise exception using errcode = '22023', message = 'Invalid calendar lock parameters.';
  end if;
  insert into public.cos_calendar_lock as existing (id, holder, expires_at)
    values ('owner', p_holder, claim_time + pg_catalog.make_interval(secs => p_seconds))
  on conflict (id) do update set holder = excluded.holder, expires_at = excluded.expires_at
    where existing.expires_at <= claim_time;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$function$;
revoke all privileges on function public.cos_calendar_claim_lock(text, integer) from public, anon, authenticated;
grant execute on function public.cos_calendar_claim_lock(text, integer) to service_role;

create or replace function public.cos_calendar_release_lock(p_holder text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  affected integer;
begin
  delete from public.cos_calendar_lock where id = 'owner' and holder = p_holder;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$function$;
revoke all privileges on function public.cos_calendar_release_lock(text) from public, anon, authenticated;
grant execute on function public.cos_calendar_release_lock(text) to service_role;

-- Fail the deployment transaction if any exposed client role can reach the
-- private calendar data/RPCs, or if a required server grant/RLS flag is absent.
do $assertions$
declare
  relation_name text;
  role_name text;
  function_name text;
  relation_oid oid;
begin
  foreach relation_name in array array[
    'cos_calendar_connection', 'cos_calendar_oauth_states', 'cos_calendar_sessions',
    'cos_calendar_bindings', 'cos_calendar_lock'
  ] loop
    relation_oid := pg_catalog.to_regclass('public.' || relation_name);
    if not exists (select 1 from pg_catalog.pg_class where oid = relation_oid and relrowsecurity and relforcerowsecurity) then
      raise exception 'Calendar table requires RLS: %', relation_name;
    end if;
    foreach role_name in array array['anon', 'authenticated'] loop
      if pg_catalog.has_table_privilege(role_name, relation_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or pg_catalog.has_any_column_privilege(role_name, relation_oid, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unexpected calendar client privilege: %.%', role_name, relation_name;
      end if;
    end loop;
    if not pg_catalog.has_table_privilege('service_role', relation_oid, 'SELECT')
       or not pg_catalog.has_table_privilege('service_role', relation_oid, 'INSERT')
       or not pg_catalog.has_table_privilege('service_role', relation_oid, 'UPDATE')
       or not pg_catalog.has_table_privilege('service_role', relation_oid, 'DELETE') then
      raise exception 'Missing calendar server privilege: %', relation_name;
    end if;
  end loop;
  foreach function_name in array array[
    'cos_calendar_private.get_config()',
    'public.cos_calendar_get_config()',
    'public.cos_calendar_claim_lock(text,integer)',
    'public.cos_calendar_release_lock(text)',
    'public.cos_calendar_touch_updated_at()'
  ] loop
    foreach role_name in array array['anon', 'authenticated'] loop
      if pg_catalog.has_function_privilege(role_name, function_name, 'EXECUTE') then
        raise exception 'Unexpected calendar function privilege: %.%', role_name, function_name;
      end if;
    end loop;
    if not pg_catalog.has_function_privilege('service_role', function_name, 'EXECUTE') then
      raise exception 'Missing calendar server function privilege: %', function_name;
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated'] loop
    if pg_catalog.has_schema_privilege(role_name, 'cos_calendar_private', 'USAGE,CREATE') then
      raise exception 'Unexpected calendar private-schema privilege: %', role_name;
    end if;
  end loop;
  if not pg_catalog.has_schema_privilege('service_role', 'cos_calendar_private', 'USAGE') then
    raise exception 'Missing calendar private-schema service privilege.';
  end if;
  if exists (select 1 from pg_catalog.pg_proc where oid = 'public.cos_calendar_get_config()'::regprocedure and prosecdef) then
    raise exception 'The public calendar configuration RPC must use SECURITY INVOKER.';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception 'The Supabase service role must bypass RLS for these private tables.';
  end if;
end;
$assertions$;

notify pgrst, 'reload schema';
commit;
