-- Defaults for new threads; existing source/audit records stay intact.
begin;
alter table public.cos_gmail_threads drop constraint cos_gmail_threads_context_days_check;
alter table public.cos_gmail_threads add constraint cos_gmail_threads_context_days_check check(context_days in(7,90,180));
alter table public.cos_gmail_threads alter column context_days set default 7;
alter table public.cos_gmail_connection alter column settings set default '{"label_ids":[],"emails":[],"enabled":false,"ai_consent":false,"auto_tasks":false,"initial_days":7,"context_days":7,"message_limit":10}'::jsonb;
commit;
