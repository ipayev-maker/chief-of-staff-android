begin;
alter table public.cos_gmail_threads drop constraint cos_gmail_threads_message_limit_check;
alter table public.cos_gmail_threads alter column message_limit set default 3;
update public.cos_gmail_threads set message_limit=3;
alter table public.cos_gmail_threads add constraint cos_gmail_threads_message_limit_check check(message_limit=3);
update public.cos_gmail_connection set settings=jsonb_set(settings,'{message_limit}','3'::jsonb);
alter table public.cos_gmail_connection alter column settings set default '{"label_ids":[],"emails":[],"enabled":false,"ai_consent":false,"auto_tasks":false,"review_before_create":true,"initial_days":7,"context_days":7,"message_limit":3}'::jsonb;
-- Preserve the installed reset implementation and its receipts/deletion guards.
do $block$ begin
  execute replace(replace(pg_get_functiondef('public.cos_gmail_reset_week()'::regprocedure),'message_limit=10','message_limit=3'),'"message_limit":10','"message_limit":3');
end $block$;
commit;
