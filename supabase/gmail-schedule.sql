-- Import is opt-in: this job is a no-op until the owner connects Gmail and
-- explicitly saves a nonempty scope with enabled=true in the application.
select cron.schedule('cos-gmail-sync','*/5 * * * *', $job$
  select net.http_post(
    url:='https://spabmyyxiufuzsaydrmx.supabase.co/functions/v1/cos-google-calendar/gmail/tick',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(s.decrypted_secret::jsonb->>'cronSecret')),
    body:='{}'::jsonb,timeout_milliseconds:=120000
  ) from vault.decrypted_secrets s
  where s.name='cos_calendar_config' and exists(
    select 1 from public.cos_gmail_connection where id='owner' and status='connected' and settings->>'enabled'='true'
  );
$job$);
