begin;
alter table public.cos_gmail_followups add column if not exists checked_at timestamptz;
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
commit;
