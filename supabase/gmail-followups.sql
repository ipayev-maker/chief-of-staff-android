begin;
create table if not exists public.cos_gmail_followups(
 task_id uuid primary key references public.commitments(id),thread_id text not null,message_id text not null,
 sent_at timestamptz not null,check_at timestamptz not null,recipients jsonb not null,
 checked_at timestamptz,status text not null default 'waiting' check(status in ('waiting','replied')),reply_message_id text,replied_at timestamptz
);
alter table public.cos_gmail_followups enable row level security;
revoke all on public.cos_gmail_followups from anon,authenticated;
grant all on public.cos_gmail_followups to service_role;
create index if not exists cos_gmail_followups_waiting_idx on public.cos_gmail_followups(thread_id,sent_at) where status='waiting';
create or replace function public.cos_gmail_track_followups() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare c jsonb;m jsonb;r jsonb;
begin
 if new.status<>'applied' or old.status='applied' or new.source_meta->>'type' is distinct from 'gmail' then return new;end if;
 for c in select value from jsonb_array_elements(coalesce(new.proposal->'changes','[]')) loop
  if c->>'kind'<>'task_create' or c->>'mail_intent'<>'request' or c->>'mail_relation'<>'waiting_for_other' then continue;end if;
  select value into m from jsonb_array_elements(new.source_meta->'messages') where value->>'id'=c->>'source_message_id';
  if lower(m->>'email') is distinct from lower(new.source_meta->>'owner_email') then continue;end if;
  select value->'after' into r from jsonb_array_elements(new.applied_result->'changes') where value->>'id'=c->>'id' and value->>'kind'='task_create';
  if r->>'next_check_at' is null then continue;end if;
  insert into public.cos_gmail_followups(task_id,thread_id,message_id,sent_at,check_at,recipients)
    values((r->>'id')::uuid,new.source_meta->>'thread_id',m->>'id',(m->>'date')::timestamptz,(r->>'next_check_at')::timestamptz,coalesce(m->'to_emails','[]')) on conflict do nothing;
 end loop;return new;
end $$;
revoke all on function public.cos_gmail_track_followups() from public,anon,authenticated;
grant execute on function public.cos_gmail_track_followups() to service_role;
create trigger cos_gmail_followup_track after update of status on public.cos_communication_inbox for each row execute function public.cos_gmail_track_followups();
create or replace function public.cos_gmail_observe_replies(p_thread text,p_messages jsonb) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare f public.cos_gmail_followups%rowtype;r jsonb;changed integer:=0;
begin
 perform public.cos_inbox_require_service();
 if p_thread !~ '^[a-zA-Z0-9_-]{1,200}$' or jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>1000 then raise exception using errcode='PT400',message='invalid_reply_metadata';end if;
 for f in select * from public.cos_gmail_followups where thread_id=p_thread and status='waiting' for update loop
  select value into r from jsonb_array_elements(p_messages) where coalesce((value->>'automatic')::boolean,false)=false and f.recipients ? lower(value->>'from') and (value->>'at')::timestamptz>f.sent_at order by value->>'at' limit 1;
  update public.cos_gmail_followups set checked_at=clock_timestamp() where task_id=f.task_id;
  if r is null then continue;end if;
  update public.cos_gmail_followups set status='replied',reply_message_id=r->>'id',replied_at=(r->>'at')::timestamptz where task_id=f.task_id;
  -- Preserve a reminder the owner manually moved, and keep the obligation open.
  update public.commitments set next_check_at=null,next_check_on=null where id=f.task_id and next_check_at=f.check_at and deleted_at is null and status='open';
  changed:=changed+1;
 end loop;return jsonb_build_object('replied',changed);
end $$;
revoke all on function public.cos_gmail_observe_replies(text,jsonb) from public,anon,authenticated;
grant execute on function public.cos_gmail_observe_replies(text,jsonb) to service_role;
commit;
