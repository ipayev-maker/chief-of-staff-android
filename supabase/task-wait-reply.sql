-- A completion and its follow-up are one transaction, with retry receipts.
begin;
create table if not exists public.cos_task_wait_requests(
 request_id uuid primary key,
 source_task_id uuid not null references public.commitments(id),
 source_version integer not null,
 followup_task_id uuid not null references public.commitments(id),
 input_hash text not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 unique(source_task_id,source_version)
);
alter table public.cos_task_wait_requests enable row level security;
revoke all on public.cos_task_wait_requests from public,anon,authenticated;
grant select,insert on public.cos_task_wait_requests to service_role;

create or replace function public.cos_task_complete_wait(p_id uuid,p_version integer,p_request_id uuid,p_patch jsonb default '{}')
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,pg_temp
as $function$
declare
 old_task public.commitments%rowtype;
 completed_task public.commitments%rowtype;
 followup public.commitments%rowtype;
 receipt public.cos_task_wait_requests%rowtype;
 fingerprint text;
 result jsonb;
 check_time timestamptz:=clock_timestamp()+interval '3 hours';
 zone text;
begin
 perform public.cos_inbox_require_service();
 if p_id is null or p_request_id is null or p_version is null or p_version<1 or jsonb_typeof(p_patch) is distinct from 'object' or octet_length(p_patch::text)>131072 then
  raise exception using errcode='PT400',message='invalid_wait_request';
 end if;
 fingerprint:=encode(sha256(convert_to(p_patch::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('cos_task_wait:'||p_request_id::text,0));
 select * into receipt from public.cos_task_wait_requests where request_id=p_request_id;
 if found then
  if receipt.source_task_id<>p_id or receipt.source_version<>p_version or receipt.input_hash<>fingerprint then raise exception using errcode='PT409',message='wait_request_conflict';end if;
  return receipt.result||jsonb_build_object('replayed',true);
 end if;
 select * into old_task from public.commitments where id=p_id for update;
 if not found or old_task.deleted_at is not null then raise exception using errcode='PT404',message='task_not_found';end if;
 select * into receipt from public.cos_task_wait_requests where source_task_id=p_id and source_version=p_version;
 if found then
  if receipt.input_hash<>fingerprint then raise exception using errcode='PT409',message='wait_request_conflict';end if;
  return receipt.result||jsonb_build_object('replayed',true);
 end if;
 if old_task.cos_version<>p_version then raise exception using errcode='PT409',message='task_version_conflict';end if;
 if old_task.status not in ('open','paused') then raise exception using errcode='PT409',message='task_already_completed';end if;
 if exists(select 1 from public.time_entries where commitment_id=p_id and source='timer' and ended_at is null) then raise exception using errcode='PT423',message='task_timer_running';end if;
 perform public.cos_inbox_task_patch(p_id,p_version,p_patch||jsonb_build_object('status','completed'));
 select * into completed_task from public.commitments where id=p_id;
 select time_zone into zone from public.cos_calendar_connection where id='owner';
 if zone is null or not exists(select 1 from pg_timezone_names where name=zone) then zone:='Europe/Moscow';end if;
 insert into public.commitments(description,details,project_id,area_key,participant_id,contact_id,direction,status,next_check_at,next_check_on)
 values(left('Дождаться ответа: '||regexp_replace(completed_task.description,'^Дождаться ответа: *','','i'),2000),
  'Ответ по задаче: '||completed_task.description||E'\nПредыдущая задача: https://nikodim.vercel.app/#/tasks/'||p_id||E'\nПроверить ответ через 3 часа. При необходимости измените время проверки.',
  completed_task.project_id,completed_task.area_key,completed_task.participant_id,completed_task.contact_id,'to_me','open',check_time,(check_time at time zone zone)::date)
 returning * into followup;
 result:=jsonb_build_object('completed',to_jsonb(completed_task),'followup',to_jsonb(followup),'replayed',false);
 insert into public.cos_task_wait_requests(request_id,source_task_id,source_version,followup_task_id,input_hash,result)
 values(p_request_id,p_id,p_version,followup.id,fingerprint,result);
 return result;
end;
$function$;
revoke all on function public.cos_task_complete_wait(uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cos_task_complete_wait(uuid,integer,uuid,jsonb) to service_role;
commit;
