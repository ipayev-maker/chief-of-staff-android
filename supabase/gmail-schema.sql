-- Private, owner-only Gmail pilot. Tokens never enter browser responses.
begin;
create table if not exists public.cos_gmail_connection (
  id text primary key default 'owner' check(id='owner'),
  google_sub text not null, email text not null, refresh_token_cipher text,
  status text not null check(status in ('connected','disconnected','needs_reconnect')),
  settings jsonb not null default '{"label_ids":[],"emails":[],"enabled":false,"ai_consent":false,"initial_days":30,"context_days":90,"message_limit":10,"pilot_limit":50}'::jsonb,
  cursor jsonb not null default '{}',last_sync_at timestamptz,last_error text,
  created_at timestamptz not null default now()
);
create table if not exists public.cos_gmail_oauth_states (
  state_hash text primary key,browser_hash text not null,verifier text not null,expires_at timestamptz not null
);
create table if not exists public.cos_gmail_lock(id text primary key check(id='owner'),holder text not null,expires_at timestamptz not null);
create table if not exists public.cos_gmail_threads (
  thread_id text primary key check(thread_id~'^[a-zA-Z0-9_-]{1,128}$'),
  subject text not null default '',history_id text,inbox_id uuid references public.cos_communication_inbox(id) on delete restrict,
  pending boolean not null default true,last_error text,project_id uuid references public.projects(id) on delete set null,
  context_days integer not null default 90 check(context_days in(90,180)),
  message_limit integer not null default 10 check(message_limit in(10,20,30,40,50)),
  message_ids jsonb not null default '[]',processed_ids jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
create index if not exists cos_gmail_threads_pending_idx on public.cos_gmail_threads(updated_at,thread_id) where pending;
create index if not exists cos_gmail_threads_inbox_idx on public.cos_gmail_threads(inbox_id) where inbox_id is not null;
create table if not exists public.cos_gmail_people (
  email text primary key,participant_id uuid not null references public.participants(id) on delete cascade
);
alter table public.cos_gmail_connection enable row level security;
alter table public.cos_gmail_oauth_states enable row level security;
alter table public.cos_gmail_lock enable row level security;
alter table public.cos_gmail_threads enable row level security;
alter table public.cos_gmail_people enable row level security;
revoke all on public.cos_gmail_connection,public.cos_gmail_oauth_states,public.cos_gmail_lock,public.cos_gmail_threads,public.cos_gmail_people from public,anon,authenticated;
grant select,insert,update,delete on public.cos_gmail_connection,public.cos_gmail_oauth_states,public.cos_gmail_lock,public.cos_gmail_threads,public.cos_gmail_people to service_role;

alter table public.quick_notes drop constraint quick_notes_source_allowed;
alter table public.quick_notes add constraint quick_notes_source_allowed check(source in('web','telegram','gmail'));
alter table public.quick_notes drop constraint quick_notes_source_identity;
alter table public.quick_notes add constraint quick_notes_source_identity check(
  (source in('web','gmail') and source_message_id is null and telegram_chat_id is null and telegram_message_id is null and telegram_update_id is null)
  or (source='telegram' and telegram_chat_id is not null and telegram_message_id is not null));

create or replace function public.cos_gmail_claim_lock(p_holder text,p_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $fn$
declare changed integer;
begin
  perform public.cos_inbox_require_service();
  if p_holder is null or length(p_holder)>200 or p_seconds not between 1 and 180 then raise exception 'invalid_lock'; end if;
  insert into public.cos_gmail_lock(id,holder,expires_at) values('owner',p_holder,clock_timestamp()+make_interval(secs=>p_seconds))
    on conflict(id) do update set holder=excluded.holder,expires_at=excluded.expires_at where cos_gmail_lock.expires_at<clock_timestamp();
  get diagnostics changed=row_count;return changed=1;
end;$fn$;
create or replace function public.cos_gmail_release_lock(p_holder text)
returns void language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $fn$
begin perform public.cos_inbox_require_service();delete from public.cos_gmail_lock where id='owner' and holder=p_holder;end;$fn$;

create or replace function public.cos_gmail_capture(p_thread_id text,p_text text,p_meta jsonb,p_subject text,p_message_ids jsonb,p_history_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $fn$
declare t public.cos_gmail_threads%rowtype;i public.cos_communication_inbox%rowtype;n public.quick_notes%rowtype;processed jsonb;
begin
  perform public.cos_inbox_require_service();
  if p_meta->>'type' is distinct from 'gmail' or p_meta->>'thread_id' is distinct from p_thread_id or char_length(p_text)>64000 or
    not(p_text~'[^[:space:]]') or octet_length(p_meta::text)>16384 or jsonb_typeof(p_message_ids)<>'array' or jsonb_array_length(p_message_ids)>50 then
    raise exception using errcode='PT400',message='invalid_mail_capture';
  end if;
  select * into t from public.cos_gmail_threads where thread_id=p_thread_id for update;
  if not found then raise exception using errcode='PT404',message='thread_not_found';end if;
  if t.inbox_id is not null then
    select * into i from public.cos_communication_inbox where id=t.inbox_id for update;
    if i.status<>'applied' or t.message_ids=p_message_ids then return jsonb_build_object('item',to_jsonb(i),'duplicate',true);end if;
  end if;
  select coalesce(jsonb_agg(distinct v),'[]') into processed from jsonb_array_elements(t.processed_ids||coalesce((select jsonb_agg(m->'id') from jsonb_array_elements(coalesce(i.source_meta->'messages','[]'::jsonb)) m),'[]'::jsonb)) as v;
  insert into public.quick_notes(title,plain_text,source,project_id) values(left(p_subject,200),p_text,'gmail',t.project_id) returning * into n;
  insert into public.cos_communication_inbox(note_id,source_text,source_meta) values(n.id,p_text,p_meta) returning * into i;
  update public.cos_gmail_threads set inbox_id=i.id,message_ids=p_message_ids,processed_ids=processed,pending=false,subject=left(p_subject,200),history_id=p_history_id,last_error=null,updated_at=now() where thread_id=p_thread_id;
  return jsonb_build_object('item',to_jsonb(i),'duplicate',false);
end;$fn$;

create or replace function public.cos_gmail_expand(p_thread_id text,p_revision integer,p_days integer,p_limit integer)
returns void language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $fn$
declare t public.cos_gmail_threads%rowtype;i public.cos_communication_inbox%rowtype;
begin
  perform public.cos_inbox_require_service();
  if p_days not in(90,180) or p_limit not in(20,30,40,50) or p_revision is null then raise exception using errcode='PT400',message='invalid_depth';end if;
  select * into t from public.cos_gmail_threads where thread_id=p_thread_id for update;
  if not found then raise exception using errcode='PT404',message='thread_not_found';end if;
  select * into i from public.cos_communication_inbox where id=t.inbox_id for update;
  if not found or i.revision<>p_revision or i.status in('processing','applied') then raise exception using errcode='PT409',message='inbox_conflict';end if;
  -- No source or draft is overwritten. Mark the old review deferred and keep it
  -- available in history; a separate expanded review will be captured next.
  update public.cos_communication_inbox set status='deferred',source_meta=source_meta||'{"superseded":true}'::jsonb,revision=revision+1,updated_at=now() where id=i.id;
  update public.cos_gmail_threads set inbox_id=null,message_ids='[]',context_days=p_days,message_limit=p_limit,pending=true,updated_at=now() where thread_id=p_thread_id;
end;$fn$;
revoke all on function public.cos_gmail_claim_lock(text,integer),public.cos_gmail_release_lock(text),public.cos_gmail_capture(text,text,jsonb,text,jsonb,text),public.cos_gmail_expand(text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.cos_gmail_claim_lock(text,integer),public.cos_gmail_release_lock(text),public.cos_gmail_capture(text,text,jsonb,text,jsonb,text),public.cos_gmail_expand(text,integer,integer,integer) to service_role;
commit;
