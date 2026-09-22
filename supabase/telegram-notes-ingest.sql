-- Apply after quick-notes-schema.sql. Transactional single-owner Telegram
-- ingestion; retries return the first committed result without overwriting it.
-- No owner IDs, tokens, raw message contents or configuration values here.
begin;

create table if not exists public.cos_notes_telegram_receipts (
  chat_id bigint not null,
  message_id bigint not null check (message_id > 0),
  update_id bigint not null unique check (update_id >= 0),
  user_id bigint not null,
  kind text not null check (kind in ('note','entities')),
  result_json jsonb not null default '{}'::jsonb check (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz not null default now(),
  primary key (chat_id,message_id)
);
alter table public.cos_notes_telegram_receipts enable row level security;
alter table public.cos_notes_telegram_receipts force row level security;
revoke all privileges on table public.cos_notes_telegram_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.cos_notes_telegram_receipts to service_role;

create or replace function public.cos_notes_ingest_telegram(
  p_update_id bigint,
  p_message_id bigint,
  p_chat_id bigint,
  p_user_id bigint,
  p_text text,
  p_kind text,
  p_project json default null,
  p_commitments json default '[]'::json,
  p_events json default '[]'::json,
  p_extracted jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
-- The reused legacy SQL helpers contain unqualified public table/function
-- names. This fixed path preserves them; pg_catalog is first and pg_temp last.
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  cfg jsonb;
  receipt public.cos_notes_telegram_receipts%rowtype;
  note_row public.quick_notes%rowtype;
  inbox_result json;
  entity_result jsonb;
  correction_result jsonb;
  inbox_id uuid;
  result jsonb;
  already_saved boolean := false;
begin
  -- The getter itself checks request.jwt role=service_role. Missing owner
  -- configuration fails closed; no caller-supplied owner identity is trusted.
  cfg := public.cos_notes_get_config();
  if p_chat_id is null or p_user_id is null
      or (cfg->>'telegramOwnerUserId') is distinct from p_user_id::text
      or (cfg->>'telegramOwnerChatId') is distinct from p_chat_id::text then
    raise exception using errcode='42501', message='Telegram owner identity is not allowed.';
  end if;
  if p_update_id is null or p_update_id < 0 or p_message_id is null or p_message_id <= 0 then
    raise exception using errcode='22023', message='Invalid Telegram source identifiers.';
  end if;

  -- Serializes different deliveries/classifier outcomes for one original
  -- message. Hash collisions only serialize unrelated work; they cannot merge it.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cos_notes_ingest:' || p_chat_id::text || ':' || p_message_id::text,0)
  );
  select * into receipt from public.cos_notes_telegram_receipts
    where chat_id=p_chat_id and message_id=p_message_id;
  if found then
    if receipt.user_id <> p_user_id then
      raise exception using errcode='42501', message='Telegram receipt owner mismatch.';
    end if;
    return receipt.result_json || pg_catalog.jsonb_build_object('duplicate',true);
  end if;

  if p_kind is null or p_kind not in ('note','entities')
      or p_text is null or not (p_text ~ '[^[:space:]]') or pg_catalog.length(p_text) > 64000 then
    raise exception using errcode='22023', message='Invalid Telegram note or entity input.';
  end if;
  if p_kind='entities' and (
      coalesce(pg_catalog.json_typeof(p_project),'null') not in ('null','object')
      or coalesce(pg_catalog.json_typeof(p_commitments),'null') <> 'array'
      or coalesce(pg_catalog.json_typeof(p_events),'null') <> 'array'
      or coalesce(pg_catalog.jsonb_typeof(p_extracted),'null') <> 'object'
  ) then
    raise exception using errcode='22023', message='Invalid extracted entity structure.';
  end if;

  -- Reserve the globally unique bot update before side effects. Concurrent
  -- reuse of one update for a different message fails and rolls back everything.
  insert into public.cos_notes_telegram_receipts(chat_id,message_id,update_id,user_id,kind)
    values(p_chat_id,p_message_id,p_update_id,p_user_id,p_kind);

  if p_kind='note' then
    -- No inbox, messages, tasks, contacts or correction mutation on this branch.
    insert into public.quick_notes(title,plain_text,source,telegram_chat_id,telegram_message_id,telegram_update_id)
      values(
        pg_catalog.left(pg_catalog.split_part(pg_catalog.replace(p_text,E'\r',''),E'\n',1),300),
        p_text,'telegram',p_chat_id,p_message_id,p_update_id
      )
      on conflict do nothing
      returning * into note_row;
    if not found then
      -- Allows safe adoption of a note created before this receipt ledger.
      -- Never replace text, unarchive, or change the existing source identity.
      -- A legacy chat/message match is not sufficient when the incoming
      -- update is already bound to another note: reject that crossed identity.
      if exists (
        select 1 from public.quick_notes
        where source='telegram' and telegram_update_id=p_update_id
          and (telegram_chat_id is distinct from p_chat_id or telegram_message_id is distinct from p_message_id)
      ) then
        raise exception using errcode='23505', message='Telegram update identity conflicts with another note.';
      end if;
      select * into note_row from public.quick_notes
        where source='telegram' and telegram_chat_id=p_chat_id and telegram_message_id=p_message_id;
      if not found then
        raise exception using errcode='23505', message='Telegram update is bound to another note.';
      end if;
      already_saved := true;
    end if;
    result := pg_catalog.jsonb_build_object(
      'kind','note','note_id',note_row.id,'inbox_id',null,
      'commitment_ids','[]'::jsonb,'duplicate',already_saved
    );
  else
    -- Keep the existing correction behavior, but commit correction, inbox,
    -- created entities and receipt together. A failure restores all of them.
    correction_result := public.consume_correction(p_telegram_user_id => p_user_id)::jsonb;
    inbox_result := public.save_to_inbox(
      p_telegram_message_id => p_message_id,
      p_telegram_user_id => p_user_id,
      p_raw_text => p_text,
      p_direction => 'incoming'
    );
    inbox_id := (inbox_result->>'id')::uuid;
    if inbox_id is null then
      raise exception using errcode='P0001', message='Inbox insertion was not confirmed.';
    end if;
    entity_result := public.save_all_entities(
      p_inbox_id => inbox_id,
      p_project => p_project,
      p_commitments => p_commitments,
      p_events => p_events,
      p_extracted_entities => p_extracted
    )::jsonb;
    if (entity_result->>'success') is distinct from 'true' then
      raise exception using errcode='P0001', message='Entity insertion was not confirmed.';
    end if;
    result := pg_catalog.jsonb_build_object(
      'kind','entities','note_id',null,'inbox_id',inbox_id,
      'project_id',entity_result->'project_id',
      'commitment_ids',coalesce(entity_result->'commitment_ids','[]'::jsonb),
      'commitments_count',entity_result->'commitments_count',
      'events_count',entity_result->'events_count',
      'corrected_inbox_id',correction_result->'corrected','duplicate',false
    );
  end if;
  update public.cos_notes_telegram_receipts set result_json=result
    where chat_id=p_chat_id and message_id=p_message_id;
  return result;
end;
$function$;
revoke all privileges on function public.cos_notes_ingest_telegram(bigint,bigint,bigint,bigint,text,text,json,json,json,jsonb)
  from public, anon, authenticated;
grant execute on function public.cos_notes_ingest_telegram(bigint,bigint,bigint,bigint,text,text,json,json,json,jsonb)
  to service_role;

do $assertions$
declare
  target oid := 'public.cos_notes_telegram_receipts'::regclass;
  fn text := 'public.cos_notes_ingest_telegram(bigint,bigint,bigint,bigint,text,text,json,json,json,jsonb)';
  role_name text;
begin
  if not exists(select 1 from pg_catalog.pg_class where oid=target and relrowsecurity and relforcerowsecurity) then
    raise exception 'Telegram receipts require enabled and forced RLS.';
  end if;
  foreach role_name in array array['anon','authenticated'] loop
    if pg_catalog.has_table_privilege(role_name,target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(role_name,target,'SELECT,INSERT,UPDATE,REFERENCES')
      or pg_catalog.has_function_privilege(role_name,fn,'EXECUTE') then
      raise exception 'Unexpected Telegram receipt/ingest privilege: %',role_name;
    end if;
  end loop;
  if not pg_catalog.has_table_privilege('service_role',target,'SELECT')
    or not pg_catalog.has_table_privilege('service_role',target,'INSERT')
    or not pg_catalog.has_table_privilege('service_role',target,'UPDATE')
    or not pg_catalog.has_function_privilege('service_role',fn,'EXECUTE') then
    raise exception 'Missing Telegram receipt/ingest service privilege.';
  end if;
end;
$assertions$;

notify pgrst,'reload schema';
commit;
