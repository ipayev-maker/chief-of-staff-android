-- Cancel one newly created entity from its durable inbox receipt. Service only.
-- Existing-task updates and project edits are never reversed by this operation.
begin;
create or replace function public.cos_inbox_cancel_created(p_id uuid,p_change_id uuid)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  item public.cos_communication_inbox%rowtype;
  action jsonb;
  current_task public.commitments%rowtype;
  current_meeting public.meetings%rowtype;
  cancelled jsonb;
begin
  perform public.cos_inbox_require_service();
  if p_id is null or p_change_id is null then raise exception using errcode='PT400',message='invalid_cancel_target'; end if;
  select * into item from public.cos_communication_inbox where id=p_id for update;
  if not found then raise exception using errcode='PT404',message='inbox_not_found'; end if;
  if item.status<>'applied' then raise exception using errcode='PT409',message='inbox_not_applied'; end if;
  select a into action from jsonb_array_elements(item.applied_result->'changes') a where a->>'id'=p_change_id::text;
  if action is null or action->>'kind' not in ('task_create','meeting_create') then
    raise exception using errcode='PT400',message='not_a_created_entity';
  end if;
  cancelled:=coalesce(item.applied_result->'cancelled_ids','[]'::jsonb);
  if cancelled ? p_change_id::text then return jsonb_build_object('item',to_jsonb(item),'replayed',true); end if;
  -- Match the apply RPC's lock order: parent project before child entity.
  perform 1 from public.projects where id=(action->'after'->>'project_id')::uuid for update;
  if action->>'kind'='task_create' then
    select * into current_task from public.commitments where id=(action->'after'->>'id')::uuid for update;
    if not found or current_task.deleted_at is not null then raise exception using errcode='PT404',message='task_not_found'; end if;
    if current_task.status<>'cancelled' then
      if current_task.cos_version is distinct from (action->'after'->>'cos_version')::integer then
        raise exception using errcode='PT409',message='task_changed_since_creation';
      end if;
      perform public.cos_inbox_task_patch(current_task.id,current_task.cos_version,'{"status":"cancelled"}'::jsonb);
    end if;
  else
    select * into current_meeting from public.meetings where id=(action->'after'->>'id')::uuid for update;
    if not found then raise exception using errcode='PT404',message='meeting_not_found'; end if;
    if current_meeting.status<>'cancelled' then
      -- Reminder delivery and the clock-driven status change are not edits.
      if (to_jsonb(current_meeting)-array['updated_at','status','reminder_sent_at']) is distinct from
        ((action->'after')-array['updated_at','status','reminder_sent_at']) then
        raise exception using errcode='PT409',message='meeting_changed_since_creation';
      end if;
      update public.meetings set status='cancelled' where id=current_meeting.id;
    end if;
  end if;
  update public.cos_communication_inbox
    set applied_result=jsonb_set(applied_result,'{cancelled_ids}',cancelled||jsonb_build_array(p_change_id::text)),
        revision=revision+1,updated_at=clock_timestamp()
    where id=p_id returning * into item;
  return jsonb_build_object('item',to_jsonb(item),'replayed',false);
end;
$function$;
revoke all on function public.cos_inbox_cancel_created(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cos_inbox_cancel_created(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
