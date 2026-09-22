-- Draft deployment script. No data import, production changes, owner IDs,
-- credentials, or changes to existing project_notes/inbox/messages permissions.
-- Single configured owner; access is only through the server's owner-session API.
begin;

create schema if not exists cos_notes_private;
revoke all privileges on schema cos_notes_private from public, anon, authenticated;
grant usage on schema cos_notes_private to service_role;

create table if not exists public.quick_notes (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  plain_text text not null,
  project_id uuid references public.projects(id) on delete set null,
  source text not null default 'web',
  source_message_id uuid references public.messages(id) on delete set null,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  telegram_update_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  revision integer not null default 1,
  constraint quick_notes_text_nonempty check (plain_text ~ '[^[:space:]]'),
  constraint quick_notes_source_allowed check (source in ('telegram', 'web')),
  constraint quick_notes_revision_positive check (revision > 0),
  constraint quick_notes_telegram_message_positive check (telegram_message_id is null or telegram_message_id > 0),
  constraint quick_notes_telegram_update_nonnegative check (telegram_update_id is null or telegram_update_id >= 0),
  constraint quick_notes_source_identity check (
    (source = 'web' and source_message_id is null and telegram_chat_id is null
      and telegram_message_id is null and telegram_update_id is null)
    or
    (source = 'telegram' and telegram_chat_id is not null and telegram_message_id is not null)
  )
);

-- This release uses one configured Telegram bot. Message IDs are chat-local;
-- update IDs are bot-local. A future multi-bot release must add bot_id to keys.
create unique index if not exists quick_notes_telegram_message_unique
  on public.quick_notes (telegram_chat_id, telegram_message_id) where source = 'telegram';
create unique index if not exists quick_notes_telegram_update_unique
  on public.quick_notes (telegram_update_id) where source = 'telegram' and telegram_update_id is not null;
create unique index if not exists quick_notes_source_message_unique
  on public.quick_notes (source_message_id) where source_message_id is not null;
create index if not exists quick_notes_active_updated_idx
  on public.quick_notes (updated_at desc, id desc) where archived_at is null;
create index if not exists quick_notes_archived_updated_idx
  on public.quick_notes (updated_at desc, id desc) where archived_at is not null;
create index if not exists quick_notes_project_idx
  on public.quick_notes (project_id) where project_id is not null;

alter table public.quick_notes enable row level security;
alter table public.quick_notes force row level security;
revoke all privileges on table public.quick_notes from public, anon, authenticated;
grant select, insert, update, delete on table public.quick_notes to service_role;

-- API PATCH must filter by both id and the client's last revision. This
-- trigger increments the server's revision and cannot be overridden by input.
create or replace function public.cos_quick_notes_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.revision := old.revision + 1;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;
revoke all privileges on function public.cos_quick_notes_version() from public, anon, authenticated;
grant execute on function public.cos_quick_notes_version() to service_role;
drop trigger if exists cos_quick_notes_before_update on public.quick_notes;
create trigger cos_quick_notes_before_update
before update on public.quick_notes
for each row execute function public.cos_quick_notes_version();

-- Provision cos_notes_config separately in Vault. Its values never enter this
-- script or the public browser bundle. Only the dedicated server API can read it.
create or replace function cos_notes_private.get_config()
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
    raise exception using errcode='42501', message='Notes configuration is restricted to the service role.';
  end if;
  select decrypted_secret into secret_text from vault.decrypted_secrets where name='cos_notes_config';
  if secret_text is null then
    raise exception using errcode='P0001', message='Notes server configuration has not been provisioned.';
  end if;
  begin
    config := secret_text::jsonb;
  exception when invalid_text_representation then
    raise exception using errcode='P0001', message='Notes server configuration is invalid.';
  end;
  if pg_catalog.jsonb_typeof(config) <> 'object' then
    raise exception using errcode='P0001', message='Notes server configuration must be an object.';
  end if;
  return config;
end;
$function$;
revoke all privileges on function cos_notes_private.get_config() from public, anon, authenticated;
grant execute on function cos_notes_private.get_config() to service_role;

create or replace function public.cos_notes_get_config()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select cos_notes_private.get_config();
$function$;
revoke all privileges on function public.cos_notes_get_config() from public, anon, authenticated;
grant execute on function public.cos_notes_get_config() to service_role;

-- Assert privacy even if default privileges change in the surrounding schema.
do $assertions$
declare
  target oid := 'public.quick_notes'::regclass;
  role_name text;
  function_name text;
begin
  if not exists (select 1 from pg_catalog.pg_class where oid = target and relrowsecurity and relforcerowsecurity) then
    raise exception 'quick_notes requires enabled and forced RLS.';
  end if;
  foreach role_name in array array['anon', 'authenticated'] loop
    if pg_catalog.has_table_privilege(role_name,target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(role_name,target,'SELECT,INSERT,UPDATE,REFERENCES')
      or pg_catalog.has_function_privilege(role_name,'public.cos_quick_notes_version()','EXECUTE') then
      raise exception 'Unexpected quick_notes client privilege: %', role_name;
    end if;
    if pg_catalog.has_schema_privilege(role_name,'cos_notes_private','USAGE,CREATE') then
      raise exception 'Unexpected notes private-schema privilege: %', role_name;
    end if;
  end loop;
  if not pg_catalog.has_table_privilege('service_role',target,'SELECT')
    or not pg_catalog.has_table_privilege('service_role',target,'INSERT')
    or not pg_catalog.has_table_privilege('service_role',target,'UPDATE')
    or not pg_catalog.has_table_privilege('service_role',target,'DELETE')
    or not pg_catalog.has_function_privilege('service_role','public.cos_quick_notes_version()','EXECUTE') then
    raise exception 'Missing quick_notes service privileges.';
  end if;
  foreach function_name in array array['cos_notes_private.get_config()', 'public.cos_notes_get_config()'] loop
    foreach role_name in array array['anon','authenticated'] loop
      if pg_catalog.has_function_privilege(role_name,function_name,'EXECUTE') then
        raise exception 'Unexpected notes configuration privilege: %.%', role_name,function_name;
      end if;
    end loop;
    if not pg_catalog.has_function_privilege('service_role',function_name,'EXECUTE') then
      raise exception 'Missing notes configuration service privilege.';
    end if;
  end loop;
  if not pg_catalog.has_schema_privilege('service_role','cos_notes_private','USAGE') then
    raise exception 'Missing notes private-schema service privilege.';
  end if;
  if exists(select 1 from pg_catalog.pg_proc where oid='public.cos_notes_get_config()'::regprocedure and prosecdef) then
    raise exception 'Public notes configuration RPC must use SECURITY INVOKER.';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname='service_role' and rolbypassrls) then
    raise exception 'quick_notes requires the Supabase service role to bypass RLS.';
  end if;
end;
$assertions$;

notify pgrst, 'reload schema';
commit;
