-- Preserve the existing 09:00 Moscow digest; authenticate its server call.
-- This updates the scheduled command and does not send a message now.
select cron.schedule('morning-digest','0 6 * * *',$job$
  select net.http_post(
    url:='https://spabmyyxiufuzsaydrmx.supabase.co/functions/v1/morning-digest',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(s.decrypted_secret::jsonb->>'cronSecret')),
    body:='{}'::jsonb,
    timeout_milliseconds:=60000
  ) from vault.decrypted_secrets s where s.name='cos_calendar_config';
$job$);
