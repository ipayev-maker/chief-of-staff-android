-- Explicit server-only reload. The normal authenticated service connection
-- satisfies the existing note-deletion guard; no trigger or RLS bypass.
begin;
create or replace function public.cos_gmail_reset_week()
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,pg_temp as $fn$
declare removed integer; archived integer;
begin
  perform public.cos_inbox_require_service();
  perform 1 from public.cos_gmail_connection where id='owner' and settings->>'reset_week'='true' for update;
  if not found then return jsonb_build_object('reset',false); end if;
  update public.cos_gmail_threads t set processed_ids=(
    select coalesce(jsonb_agg(distinct value),'[]'::jsonb)
    from jsonb_array_elements(t.processed_ids||coalesce((
      select jsonb_agg(m->'id') from public.cos_communication_inbox i
      cross join lateral jsonb_array_elements(coalesce(i.source_meta->'messages','[]'::jsonb)) m
      where i.source_meta->>'type'='gmail' and i.source_meta->>'thread_id'=t.thread_id and i.status='applied'
    ),'[]'::jsonb))
  );
  update public.quick_notes n set deleted_at=now() where n.source='gmail' and n.deleted_at is null
    and exists(select 1 from public.cos_communication_inbox i where i.note_id=n.id and (i.source_meta->>'message_date')::timestamptz<now()-interval '7 days');
  get diagnostics removed=row_count;
  update public.quick_notes n set archived_at=now() where n.source='gmail' and n.deleted_at is null and n.archived_at is null
    and exists(select 1 from public.cos_communication_inbox i where i.note_id=n.id and i.source_meta->>'type'='gmail' and i.status<>'applied');
  get diagnostics archived=row_count;
  update public.cos_communication_inbox set
    source_meta=source_meta||jsonb_build_object('delivery','retired','retired_reason','week_reload')||case when status<>'applied' then '{"superseded":true}'::jsonb else '{}'::jsonb end,
    status=case when status='applied' then status else 'deferred' end,revision=revision+1,updated_at=now()
    where source_meta->>'type'='gmail';
  update public.cos_gmail_threads set inbox_id=null,message_ids='[]'::jsonb,pending=false,last_error=null,context_days=7,message_limit=10,updated_at=now();
  update public.cos_gmail_connection set settings=(settings-'pilot_limit'-'reset_week')||'{"auto_tasks":true,"initial_days":7,"context_days":7,"message_limit":10,"enabled":true}'::jsonb,
    cursor='{}'::jsonb,last_error=null where id='owner';
  return jsonb_build_object('reset',true,'removed',removed,'archived',archived);
end;$fn$;
revoke all on function public.cos_gmail_reset_week() from public,anon,authenticated;
grant execute on function public.cos_gmail_reset_week() to service_role;
commit;
