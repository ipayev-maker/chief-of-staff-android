-- Run after calendar-schema.sql, Vault configuration and Edge Function deployment.
-- Credentials are read inside Postgres; this job contains no literal secrets.
select cron.schedule(
  'cos-google-calendar-sync',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://spabmyyxiufuzsaydrmx.supabase.co/functions/v1/cos-google-calendar/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (s.decrypted_secret::jsonb ->> 'cronSecret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  from vault.decrypted_secrets s
  where s.name = 'cos_calendar_config'
    and exists (
      select 1 from public.cos_calendar_connection
      where id = 'owner' and status = 'connected'
    );
  $job$
);
