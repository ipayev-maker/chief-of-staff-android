-- Private communication capture and explicit owner-confirmed application.
-- Apply after quick-notes, Telegram receipts, note-task-links and project-brief.
-- No communication is converted into a task or project state during capture.
begin;

create table if not exists public.cos_communication_inbox (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null unique references public.quick_notes(id) on delete restrict,
  source_text text not null check (source_text ~ '[^[:space:]]' and char_length(source_text)<=64000),
  source_meta jsonb not null default '{}' check (jsonb_typeof(source_meta)='object' and octet_length(source_meta::text)<=16384),
  transcript text check (transcript is null or (transcript ~ '[^[:space:]]' and char_length(transcript)<=64000)),
  status text not null default 'captured' check (status in ('captured','processing','ready','deferred','applied','error')),
  revision integer not null default 1 check (revision>0),
  proposal jsonb not null default '{}' check (jsonb_typeof(proposal)='object' and octet_length(proposal::text)<=262144),
  processing_started_at timestamptz,
  attempt_id uuid,
  error_code text check (error_code is null or (error_code ~ '^[a-zA-Z0-9_:-]{1,100}$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  applied_result jsonb,
  constraint cos_communication_applied_stamp check ((status='applied')=(applied_at is not null))
);
create index if not exists cos_communication_pending_idx on public.cos_communication_inbox(updated_at desc,id desc) where status<>'applied';
create index if not exists cos_communication_created_idx on public.cos_communication_inbox(created_at desc,id desc);

create table if not exists public.cos_communication_requests (
  request_id uuid primary key,
  inbox_id uuid not null references public.cos_communication_inbox(id) on delete restrict,
  kind text not null check (kind in ('update','apply')),
  base_revision integer not null check (base_revision>0),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb not null,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists cos_communication_requests_inbox_idx on public.cos_communication_requests(inbox_id,created_at desc);
create table if not exists public.cos_communication_reply_claims (
  inbox_id uuid not null references public.cos_communication_inbox(id) on delete restrict,
  channel text not null check (channel='telegram'),
  claimed_at timestamptz not null default now(),
  primary key(inbox_id,channel)
);

alter table public.cos_communication_inbox enable row level security;
alter table public.cos_communication_inbox force row level security;
alter table public.cos_communication_requests enable row level security;
alter table public.cos_communication_requests force row level security;
alter table public.cos_communication_reply_claims enable row level security;
alter table public.cos_communication_reply_claims force row level security;
revoke all on public.cos_communication_inbox,public.cos_communication_requests,public.cos_communication_reply_claims from public,anon,authenticated,service_role;
grant select,insert,update on public.cos_communication_inbox to service_role;
grant select,insert on public.cos_communication_requests,public.cos_communication_reply_claims to service_role;

create or replace function public.cos_inbox_require_service()
returns void language plpgsql stable security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then
    raise exception using errcode='42501',message='service_role_required';
  end if;
end;
$function$;

create or replace function public.cos_inbox_capture_telegram(
  p_update_id bigint,p_message_id bigint,p_chat_id bigint,p_user_id bigint,p_text text,p_source_meta jsonb default '{}'
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  captured jsonb;
  item public.cos_communication_inbox%rowtype;
  note public.quick_notes%rowtype;
  replay boolean;
begin
  perform public.cos_inbox_require_service();
  if jsonb_typeof(p_source_meta) is distinct from 'object' or octet_length(p_source_meta::text)>16384 then
    raise exception using errcode='PT400',message='invalid_source_metadata';
  end if;
  -- This legacy helper validates configured Telegram owner and reserves the
  -- chat/message + bot update identity under one transaction advisory lock.
  captured := public.cos_notes_ingest_telegram(p_update_id,p_message_id,p_chat_id,p_user_id,p_text,'note');
  if captured->>'kind'<>'note' or captured->>'note_id' is null then
    -- Existing legacy entity receipts are never reprocessed into duplicate tasks.
    raise exception using errcode='PT409',message='source_already_processed_by_legacy';
  end if;
  select * into note from public.quick_notes where id=(captured->>'note_id')::uuid for share;
  select * into item from public.cos_communication_inbox where note_id=note.id;
  if found then return jsonb_build_object('item',to_jsonb(item),'duplicate',true); end if;
  if note.archived_at is not null or note.deleted_at is not null then
    raise exception using errcode='PT410',message='source_archived_or_deleted';
  end if;
  insert into public.cos_communication_inbox(note_id,source_text,source_meta)
    values(note.id,note.plain_text,p_source_meta) returning * into item;
  return jsonb_build_object('item',to_jsonb(item),'duplicate',false);
end;
$function$;

create or replace function public.cos_inbox_update(p_id uuid,p_revision integer,p_request_id uuid,p_patch jsonb)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  item public.cos_communication_inbox%rowtype;
  receipt public.cos_communication_requests%rowtype;
  fingerprint text;
  next_status text;
  field text;
  value jsonb;
  result jsonb;
  stamp timestamptz := clock_timestamp();
begin
  perform public.cos_inbox_require_service();
  if p_id is null or p_revision is null or p_revision<1 or p_revision>=2147483647 or p_request_id is null
    or jsonb_typeof(p_patch) is distinct from 'object' or p_patch='{}'::jsonb or octet_length(p_patch::text)>360448 then
    raise exception using errcode='PT400',message='invalid_inbox_update';
  end if;
  for field,value in select e.key,e.value from jsonb_each(p_patch) e loop
    if field not in ('transcript','proposal','status','error_code','source_meta','attempt_id') then
      raise exception using errcode='PT400',message='unsupported_inbox_field';
    end if;
  end loop;
  if p_patch ? 'attempt_id' and (jsonb_typeof(p_patch->'attempt_id')<>'string' or p_patch->>'attempt_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode='PT400',message='invalid_attempt_id';
  end if;
  if p_patch ? 'transcript' and (jsonb_typeof(p_patch->'transcript')<>'string' or not ((p_patch->>'transcript') ~ '[^[:space:]]') or char_length(p_patch->>'transcript')>64000) then
    raise exception using errcode='PT400',message='invalid_transcript';
  end if;
  if p_patch ? 'proposal' and (jsonb_typeof(p_patch->'proposal')<>'object' or octet_length((p_patch->'proposal')::text)>262144) then
    raise exception using errcode='PT400',message='invalid_proposal';
  end if;
  if p_patch ? 'status' and (jsonb_typeof(p_patch->'status')<>'string' or p_patch->>'status' not in ('captured','processing','ready','deferred','error')) then
    raise exception using errcode='PT400',message='invalid_inbox_status';
  end if;
  if p_patch ? 'error_code' and p_patch->'error_code'<>'null'::jsonb and
    (jsonb_typeof(p_patch->'error_code')<>'string' or p_patch->>'error_code' !~ '^[a-zA-Z0-9_:-]{1,100}$') then
    raise exception using errcode='PT400',message='invalid_inbox_error';
  end if;
  if p_patch ? 'source_meta' then
    if jsonb_typeof(p_patch->'source_meta')<>'object' then raise exception using errcode='PT400',message='invalid_source_metadata'; end if;
    for field,value in select e.key,e.value from jsonb_each(p_patch->'source_meta') e loop
      if field not in ('audio_path','audio_bucket','audio_mime_type','audio_size_bytes','audio_duration_seconds','transcription_language','audio_error') then
        raise exception using errcode='PT400',message='immutable_source_metadata';
      end if;
      if value<>'null'::jsonb and ((field in ('audio_size_bytes','audio_duration_seconds') and (jsonb_typeof(value)<>'number' or (value::text)::numeric<0)) or
        (field not in ('audio_size_bytes','audio_duration_seconds') and (jsonb_typeof(value)<>'string' or char_length(value#>>'{}')>1024))) then
        raise exception using errcode='PT400',message='invalid_audio_metadata';
      end if;
    end loop;
    if p_patch->'source_meta' ? 'audio_bucket' and (p_patch->'source_meta'->>'audio_bucket') is distinct from 'cos-communication-audio' then
      raise exception using errcode='PT400',message='invalid_audio_bucket';
    end if;
  end if;
  fingerprint := encode(sha256(convert_to(p_patch::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('cos_inbox_request:'||p_request_id::text,0));
  select * into receipt from public.cos_communication_requests where request_id=p_request_id;
  if found then
    if receipt.inbox_id<>p_id or receipt.kind<>'update' or receipt.base_revision<>p_revision or receipt.input_hash<>fingerprint then
      raise exception using errcode='PT409',message='inbox_request_conflict';
    end if;
    return receipt.result_json || jsonb_build_object('replayed',true);
  end if;
  select * into item from public.cos_communication_inbox where id=p_id for update;
  if not found then raise exception using errcode='PT404',message='inbox_not_found'; end if;
  if item.revision<>p_revision or item.status='applied' then raise exception using errcode='PT409',message='inbox_revision_conflict'; end if;
  next_status := coalesce(p_patch->>'status',item.status);
  if p_patch ? 'attempt_id' and coalesce(p_patch->>'status','')<>'processing' and (p_patch->>'attempt_id')::uuid is distinct from item.attempt_id then
    raise exception using errcode='PT409',message='inbox_attempt_conflict';
  end if;
  if octet_length((item.source_meta||coalesce(p_patch->'source_meta','{}'::jsonb))::text)>16384 then
    raise exception using errcode='PT400',message='source_metadata_too_large';
  end if;
  if item.source_meta->>'audio_path' is not null and p_patch->'source_meta' ? 'audio_path' and
    item.source_meta->'audio_path' is distinct from p_patch->'source_meta'->'audio_path' then
    raise exception using errcode='PT409',message='immutable_audio_source';
  end if;
  if p_patch->>'status'='processing' and item.status='processing' and item.processing_started_at>stamp-interval '2 minutes' then
    raise exception using errcode='PT409',message='inbox_processing_lease';
  end if;
  if p_patch ? 'transcript' then
    perform 1 from public.quick_notes where id=item.note_id and archived_at is null and deleted_at is null for update;
    if not found then raise exception using errcode='PT410',message='source_archived_or_deleted'; end if;
    update public.quick_notes set plain_text=p_patch->>'transcript',title=left(split_part(replace(p_patch->>'transcript',E'\r',''),E'\n',1),300) where id=item.note_id and plain_text=coalesce(item.transcript,item.source_text)
      and (item.source_meta->>'type' is distinct from 'voice' or item.source_text='[Голосовое сообщение]');
  end if;
  update public.cos_communication_inbox set
    transcript=case when p_patch ? 'transcript' then p_patch->>'transcript' else transcript end,
    proposal=case when p_patch ? 'proposal' then p_patch->'proposal' else proposal end,
    status=next_status,
    source_meta=source_meta||coalesce(p_patch->'source_meta','{}'::jsonb),
    error_code=case when p_patch ? 'error_code' then p_patch->>'error_code' else error_code end,
    processing_started_at=case when p_patch->>'status'='processing' or (next_status='processing' and p_patch ? 'attempt_id') then stamp when next_status<>'processing' then null else processing_started_at end,
    attempt_id=case when p_patch->>'status'='processing' then coalesce((p_patch->>'attempt_id')::uuid,gen_random_uuid()) else attempt_id end,
    revision=revision+1,updated_at=stamp
    where id=p_id returning * into item;
  result := jsonb_build_object('item',to_jsonb(item),'replayed',false);
  insert into public.cos_communication_requests(request_id,inbox_id,kind,base_revision,input_hash,input_json,result_json)
    values(p_request_id,p_id,'update',p_revision,fingerprint,p_patch,result);
  return result;
end;
$function$;

-- Full typed validation shared by task updates; omitted patch fields preserve
-- their locked existing values. No model-supplied metadata enters task history.
create or replace function public.cos_inbox_task_patch(p_task_id uuid,p_version integer,p_patch jsonb)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $function$
declare
  old_task public.commitments%rowtype;
  candidate public.commitments%rowtype;
  saved public.commitments%rowtype;
  field text;
  value jsonb;
  normalized jsonb;
begin
  perform public.cos_inbox_require_service();
  if p_task_id is null or p_version is null or p_version<1 or jsonb_typeof(p_patch) is distinct from 'object' or p_patch='{}'::jsonb then
    raise exception using errcode='PT400',message='invalid_task_patch';
  end if;
  select * into old_task from public.commitments where id=p_task_id for update;
  if not found then raise exception using errcode='PT404',message='task_not_found'; end if;
  if old_task.deleted_at is not null then raise exception using errcode='PT410',message='task_deleted'; end if;
  if old_task.cos_version<>p_version then raise exception using errcode='PT409',message='task_version_conflict'; end if;
  for field,value in select e.key,e.value from jsonb_each(p_patch) e loop
    if field not in ('description','details','status','direction','project_id','area_key','participant_id','deadline','planned_on','next_check_on','planned_start_at','planned_end_at','deadline_at','next_check_at','estimate_minutes') then
      raise exception using errcode='PT400',message='unsupported_task_field';
    end if;
    if value<>'null'::jsonb then
      if field='estimate_minutes' then
        if jsonb_typeof(value)<>'number' then raise exception using errcode='PT400',message='invalid_task_estimate'; end if;
        if (value::text)::numeric<>trunc((value::text)::numeric) or (value::text)::numeric not between 1 and 525600 then
          raise exception using errcode='PT400',message='invalid_task_estimate';
        end if;
      elsif jsonb_typeof(value)<>'string' then raise exception using errcode='PT400',message='invalid_task_field_type'; end if;
      if field in ('deadline','planned_on','next_check_on') and p_patch->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception using errcode='PT400',message='invalid_task_date'; end if;
      if field in ('planned_start_at','planned_end_at','deadline_at','next_check_at') and p_patch->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode='PT400',message='invalid_task_timestamp';
      end if;
    end if;
  end loop;
  begin
    candidate := jsonb_populate_record(old_task,p_patch);
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception using errcode='PT400',message='invalid_task_value';
  end;
  candidate.description:=btrim(candidate.description);
  if candidate.description is null or candidate.description !~ '[^[:space:]]' or char_length(candidate.description)>2000
    or candidate.details is null or char_length(candidate.details)>64000 or char_length(candidate.area_key)>100
    or candidate.status is null or candidate.status not in ('open','paused','completed','cancelled')
    or candidate.direction is null or candidate.direction not in ('internal','from_me','to_me')
    or (candidate.planned_end_at is not null and (candidate.planned_start_at is null or candidate.planned_end_at<candidate.planned_start_at)) then
    raise exception using errcode='PT400',message='invalid_task_content';
  end if;
  if candidate.project_id is distinct from old_task.project_id and candidate.project_id is not null then
    if not exists(select 1 from public.projects where id=candidate.project_id and status='active') then
      raise exception using errcode='PT400',message='project_not_active';
    end if;
  end if;
  begin
    update public.commitments set description=candidate.description,details=candidate.details,status=candidate.status,
      direction=candidate.direction,project_id=candidate.project_id,area_key=candidate.area_key,participant_id=candidate.participant_id,
      deadline=candidate.deadline,planned_on=candidate.planned_on,next_check_on=candidate.next_check_on,
      planned_start_at=candidate.planned_start_at,planned_end_at=candidate.planned_end_at,deadline_at=candidate.deadline_at,
      next_check_at=candidate.next_check_at,estimate_minutes=candidate.estimate_minutes
      where id=p_task_id returning * into saved;
  exception when foreign_key_violation or check_violation or not_null_violation then
    raise exception using errcode='PT400',message='invalid_task_reference';
  end;
  return jsonb_build_object('task',to_jsonb(saved),'before',to_jsonb(old_task));
end;
$function$;

create or replace function public.cos_inbox_apply(p_id uuid,p_revision integer,p_request_id uuid,p_actions jsonb,p_confirmation jsonb default null)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  item public.cos_communication_inbox%rowtype;
  receipt public.cos_communication_requests%rowtype;
  action jsonb;
  action_id uuid;
  kind text;
  action_ids uuid[]:='{}';
  task_ids uuid[]:='{}';
  brief_ids uuid[]:='{}';
  project_id uuid;
  field text;
  fingerprint text;
  one jsonb;
  before_value jsonb;
  results jsonb:=jsonb_build_object('tasks','[]'::jsonb,'meetings','[]'::jsonb,'briefs','[]'::jsonb,'changes','[]'::jsonb);
  result jsonb;
begin
  perform public.cos_inbox_require_service();
  if p_id is null or p_revision is null or p_revision<1 or p_revision>=2147483647 or p_request_id is null
    or jsonb_typeof(p_actions) is distinct from 'array' then raise exception using errcode='PT400',message='invalid_inbox_apply'; end if;
  if jsonb_array_length(p_actions)>30 or octet_length(p_actions::text)>524288 then raise exception using errcode='PT400',message='inbox_apply_too_large'; end if;
  if p_confirmation is not null and (jsonb_typeof(p_confirmation)<>'object' or octet_length(p_confirmation::text)>131072) then
    raise exception using errcode='PT400',message='invalid_apply_confirmation';
  end if;
  fingerprint:=encode(sha256(convert_to((case when p_confirmation is null then p_actions else p_confirmation end)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('cos_inbox_request:'||p_request_id::text,0));
  select * into receipt from public.cos_communication_requests where request_id=p_request_id;
  if found then
    if receipt.inbox_id<>p_id or receipt.kind<>'apply' or receipt.base_revision<>p_revision or receipt.input_hash<>fingerprint
      or (receipt.input_json->'confirmation' is distinct from coalesce(p_confirmation,'null'::jsonb)) then
      raise exception using errcode='PT409',message='inbox_request_conflict';
    end if;
    return receipt.result_json||jsonb_build_object('replayed',true);
  end if;
  select * into item from public.cos_communication_inbox where id=p_id for update;
  if not found then raise exception using errcode='PT404',message='inbox_not_found'; end if;
  if item.revision<>p_revision or item.status not in ('ready','deferred') then raise exception using errcode='PT409',message='inbox_revision_conflict'; end if;
  perform 1 from public.quick_notes where id=item.note_id and archived_at is null and deleted_at is null for share;
  if not found then raise exception using errcode='PT410',message='source_archived_or_deleted'; end if;

  -- Validate the operation envelope before any mutations. Unknown fields and
  -- duplicate operations are rejected, including two patches of the same task.
  for action in select value from jsonb_array_elements(p_actions) loop
    if jsonb_typeof(action)<>'object' or not (action ?& array['id','kind']) or jsonb_typeof(action->'id')<>'string'
      or action->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode='PT400',message='invalid_inbox_action';
    end if;
    action_id:=(action->>'id')::uuid;
    if action_id=any(action_ids) then raise exception using errcode='PT400',message='duplicate_inbox_action'; end if;
    action_ids:=array_append(action_ids,action_id);
    kind:=action->>'kind';
    if kind='task_create' then
      if (select count(*) from jsonb_object_keys(action))<>3 or jsonb_typeof(action->'task') is distinct from 'object' then
        raise exception using errcode='PT400',message='invalid_task_create_action';
      end if;
    elsif kind='meeting_create' then
      if (select count(*) from jsonb_object_keys(action))<>3 or jsonb_typeof(action->'meeting') is distinct from 'object'
        or not (action->'meeting' ?& array['title','project_id','starts_at','ends_at','agenda'])
        or (select count(*) from jsonb_object_keys(action->'meeting'))<>5
        or jsonb_typeof(action->'meeting'->'title') is distinct from 'string'
        or length(btrim(action->'meeting'->>'title')) not between 1 and 2000
        or jsonb_typeof(action->'meeting'->'agenda') is distinct from 'string'
        or length(action->'meeting'->>'agenda')>5000
        or jsonb_typeof(action->'meeting'->'starts_at') is distinct from 'string'
        or jsonb_typeof(action->'meeting'->'ends_at') is distinct from 'string'
        or action->'meeting'->>'starts_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$'
        or action->'meeting'->>'ends_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$'
        or (action->'meeting'->>'ends_at')::timestamptz<=(action->'meeting'->>'starts_at')::timestamptz
        or (action->'meeting'->>'ends_at')::timestamptz-(action->'meeting'->>'starts_at')::timestamptz>interval '24 hours'
        or jsonb_typeof(action->'meeting'->'project_id') not in ('null','string') then
        raise exception using errcode='PT400',message='invalid_meeting_create_action';
      end if;
    elsif kind='task_update' then
      if (select count(*) from jsonb_object_keys(action))<>5 or not (action ?& array['task_id','version','patch'])
        or jsonb_typeof(action->'patch')<>'object' or jsonb_typeof(action->'version')<>'number' or (action->>'version') !~ '^[1-9][0-9]{0,9}$' then
        raise exception using errcode='PT400',message='invalid_task_update_action';
      end if;
      if (action->>'task_id')::uuid=any(task_ids) then raise exception using errcode='PT400',message='duplicate_task_update'; end if;
      task_ids:=array_append(task_ids,(action->>'task_id')::uuid);
    elsif kind='brief_replace' then
      if (select count(*) from jsonb_object_keys(action))<>5 or not (action ?& array['project_id','revision','document'])
        or jsonb_typeof(action->'revision')<>'number' or (action->>'revision') !~ '^[0-9]{1,10}$' or not public.cos_valid_project_brief(action->'document') then
        raise exception using errcode='PT400',message='invalid_brief_action';
      end if;
      if (action->>'project_id')::uuid=any(brief_ids) then raise exception using errcode='PT400',message='duplicate_project_update'; end if;
      brief_ids:=array_append(brief_ids,(action->>'project_id')::uuid);
    else raise exception using errcode='PT400',message='unsupported_inbox_action'; end if;
  end loop;
  -- Use one project lock order across multi-project batches. Task triggers also
  -- update these parent rows; no later operation can partly commit this batch.
  for project_id in
    select distinct p.id from public.projects p where p.id in (
      select (a->'task'->>'project_id')::uuid from jsonb_array_elements(p_actions) a where a->>'kind'='task_create'
      union select (a->'meeting'->>'project_id')::uuid from jsonb_array_elements(p_actions) a where a->>'kind'='meeting_create'
      union select (a->'patch'->>'project_id')::uuid from jsonb_array_elements(p_actions) a where a->>'kind'='task_update'
      union select c.project_id from public.commitments c where c.id=any(task_ids)
      union select unnest(brief_ids)) order by p.id
  loop perform 1 from public.projects where id=project_id for update; end loop;

  for action in select value from jsonb_array_elements(p_actions) loop
    action_id:=(action->>'id')::uuid; kind:=action->>'kind';
    if kind='task_create' then
      project_id:=(action->'task'->>'project_id')::uuid;
      if project_id is not null and not exists(select 1 from public.projects where id=project_id and status='active') then
        raise exception using errcode='PT400',message='project_not_active';
      end if;
      one:=public.cos_notes_create_task('quick',item.note_id,action_id,action->'task');
      results:=jsonb_set(results,'{tasks}',results->'tasks'||jsonb_build_array(one->'task'));
      results:=jsonb_set(results,'{changes}',results->'changes'||jsonb_build_array(jsonb_build_object('id',action_id,'kind',kind,'before',null,'after',one->'task')));
    elsif kind='meeting_create' then
      project_id:=(action->'meeting'->>'project_id')::uuid;
      if project_id is not null and not exists(select 1 from public.projects where id=project_id and status='active') then
        raise exception using errcode='PT400',message='project_not_active';
      end if;
      insert into public.meetings(id,title,project_id,starts_at,ends_at,agenda,status)
        values(action_id,btrim(action->'meeting'->>'title'),project_id,(action->'meeting'->>'starts_at')::timestamptz,
          (action->'meeting'->>'ends_at')::timestamptz,action->'meeting'->>'agenda','scheduled')
        returning to_jsonb(meetings.*) into one;
      results:=jsonb_set(results,'{meetings}',results->'meetings'||jsonb_build_array(one));
      results:=jsonb_set(results,'{changes}',results->'changes'||jsonb_build_array(jsonb_build_object('id',action_id,'kind',kind,'before',null,'after',one)));
    elsif kind='task_update' then
      one:=public.cos_inbox_task_patch((action->>'task_id')::uuid,(action->>'version')::integer,action->'patch');
      results:=jsonb_set(results,'{tasks}',results->'tasks'||jsonb_build_array(one->'task'));
      results:=jsonb_set(results,'{changes}',results->'changes'||jsonb_build_array(jsonb_build_object('id',action_id,'kind',kind,'before',one->'before','after',one->'task')));
    else
      project_id:=(action->>'project_id')::uuid;
      if not exists(select 1 from public.projects where id=project_id and status='active') then raise exception using errcode='PT400',message='project_not_active'; end if;
      before_value:=public.cos_get_project_brief(project_id);
      one:=public.cos_save_project_brief(project_id,(action->>'revision')::integer,action_id,action->'document');
      results:=jsonb_set(results,'{briefs}',results->'briefs'||jsonb_build_array(one));
      results:=jsonb_set(results,'{changes}',results->'changes'||jsonb_build_array(jsonb_build_object('id',action_id,'kind',kind,'before',before_value,'after',one)));
    end if;
  end loop;
  if p_confirmation->'proposal' ? 'changes' and jsonb_typeof(p_confirmation->'proposal'->'changes')<>'array' then
    raise exception using errcode='PT400',message='invalid_confirmed_changes';
  end if;
  update public.cos_communication_inbox set status='applied',revision=revision+1,updated_at=clock_timestamp(),applied_at=clock_timestamp(),processing_started_at=null,error_code=null,
    proposal=case when p_confirmation->'proposal' ? 'changes' then jsonb_set(proposal,'{changes}',p_confirmation->'proposal'->'changes') else proposal end,
    applied_result=results where id=p_id returning * into item;
  result:=jsonb_build_object('item',to_jsonb(item),'result',results,'replayed',false);
  insert into public.cos_communication_requests(request_id,inbox_id,kind,base_revision,input_hash,input_json,result_json)
    values(p_request_id,p_id,'apply',p_revision,fingerprint,jsonb_build_object('actions',p_actions,'confirmation',p_confirmation),result);
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode='PT400',message='invalid_inbox_action_value';
end;
$function$;

create or replace function public.cos_inbox_claim_reply(p_id uuid,p_channel text default 'telegram')
returns boolean language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare claimed integer;
begin
  perform public.cos_inbox_require_service();
  if p_id is null or p_channel is distinct from 'telegram' then raise exception using errcode='PT400',message='invalid_reply_claim'; end if;
  if not exists(select 1 from public.cos_communication_inbox where id=p_id) then raise exception using errcode='PT404',message='inbox_not_found'; end if;
  insert into public.cos_communication_reply_claims(inbox_id,channel) values(p_id,p_channel) on conflict do nothing;
  get diagnostics claimed = row_count;
  return claimed=1;
end;
$function$;

revoke all on function public.cos_inbox_require_service(),public.cos_inbox_capture_telegram(bigint,bigint,bigint,bigint,text,jsonb),
  public.cos_inbox_update(uuid,integer,uuid,jsonb),public.cos_inbox_task_patch(uuid,integer,jsonb),
  public.cos_inbox_apply(uuid,integer,uuid,jsonb,jsonb),public.cos_inbox_claim_reply(uuid,text) from public,anon,authenticated;
grant execute on function public.cos_inbox_require_service(),public.cos_inbox_capture_telegram(bigint,bigint,bigint,bigint,text,jsonb),
  public.cos_inbox_update(uuid,integer,uuid,jsonb),public.cos_inbox_task_patch(uuid,integer,jsonb),
  public.cos_inbox_apply(uuid,integer,uuid,jsonb,jsonb),public.cos_inbox_claim_reply(uuid,text) to service_role;

-- Private bucket only. Browser reads use short-lived authenticated server URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('cos-communication-audio','cos-communication-audio',false,20971520,array['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm','application/ogg'])
  on conflict(id) do nothing;

do $assertions$
declare target text; fn text; client_role text;
begin
  foreach target in array array['cos_communication_inbox','cos_communication_requests','cos_communication_reply_claims'] loop
    if not exists(select 1 from pg_class where oid=('public.'||target)::regclass and relrowsecurity and relforcerowsecurity) then raise exception 'Inbox table requires forced RLS: %',target; end if;
    foreach client_role in array array['anon','authenticated'] loop
      if has_table_privilege(client_role,'public.'||target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(client_role,'public.'||target,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unexpected inbox client privilege: %',target; end if;
    end loop;
  end loop;
  foreach fn in array array['cos_inbox_require_service()','cos_inbox_capture_telegram(bigint,bigint,bigint,bigint,text,jsonb)','cos_inbox_update(uuid,integer,uuid,jsonb)','cos_inbox_task_patch(uuid,integer,jsonb)','cos_inbox_apply(uuid,integer,uuid,jsonb,jsonb)','cos_inbox_claim_reply(uuid,text)'] loop
    foreach client_role in array array['anon','authenticated'] loop
      if has_function_privilege(client_role,'public.'||fn,'EXECUTE') then raise exception 'Unexpected inbox RPC privilege: %',fn; end if;
    end loop;
    if exists(select 1 from pg_proc where oid=('public.'||fn)::regprocedure and prosecdef) then raise exception 'Inbox RPC must be security invoker: %',fn; end if;
  end loop;
  if exists(select 1 from storage.buckets where id='cos-communication-audio' and public) then raise exception 'Communication audio bucket must remain private'; end if;
end;
$assertions$;
notify pgrst,'reload schema';
commit;
