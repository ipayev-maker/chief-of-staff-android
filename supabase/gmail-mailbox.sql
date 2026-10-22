begin;
create index if not exists cos_inbox_mail_review_pending_idx on public.cos_communication_inbox((source_meta->>'thread_id')) where status='ready' and source_meta->>'delivery'='review';
create or replace view public.cos_gmail_mailbox with(security_invoker=true) as
 select t.*,
 coalesce((i.source_meta->>'message_date')::timestamptz,t.updated_at) as last_message_at,
 (select count(*) from public.cos_communication_inbox r where r.source_meta->>'thread_id'=t.thread_id and r.source_meta->>'delivery'='review' and r.status='ready' and coalesce(r.source_meta->>'superseded','false')<>'true') as review_count
 from public.cos_gmail_threads t left join public.cos_communication_inbox i on i.id=t.inbox_id;
revoke all on public.cos_gmail_mailbox from anon,authenticated;
grant select on public.cos_gmail_mailbox to service_role;
commit;
