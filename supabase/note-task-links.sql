-- Apply after quick-notes-schema.sql. Only an owner-authenticated server may
-- invoke this RPC with the service key. No existing access rules are widened.
begin;

create table if not exists public.cos_note_task_links (
  request_id uuid primary key,
  source_kind text not null check (source_kind in ('quick','project')),
  quick_note_id uuid references public.quick_notes(id) on delete restrict,
  project_note_id uuid references public.project_notes(id) on delete restrict,
  source_id uuid generated always as (coalesce(quick_note_id,project_note_id)) stored,
  commitment_id uuid not null unique references public.commitments(id) on delete restrict,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint cos_note_task_links_exact_source check (
    (source_kind='quick' and quick_note_id is not null and project_note_id is null)
    or (source_kind='project' and project_note_id is not null and quick_note_id is null)
  )
);
create index if not exists cos_note_task_links_source_idx
  on public.cos_note_task_links(source_kind,source_id,created_at desc);
create index if not exists cos_note_task_links_quick_fk_idx
  on public.cos_note_task_links(quick_note_id) where quick_note_id is not null;
create index if not exists cos_note_task_links_project_fk_idx
  on public.cos_note_task_links(project_note_id) where project_note_id is not null;
alter table public.cos_note_task_links enable row level security;
alter table public.cos_note_task_links force row level security;
revoke all privileges on table public.cos_note_task_links from public, anon, authenticated;
grant select, insert on table public.cos_note_task_links to service_role;

create or replace function public.cos_notes_create_task(
  p_source_kind text,
  p_source_id uuid,
  p_request_id uuid,
  p_task jsonb
)
returns jsonb
language plpgsql
security invoker
-- Existing commitment risk triggers use unqualified public helper names.
set search_path = pg_catalog, public, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $function$
declare
  request_role text;
  input public.commitments%rowtype;
  task public.commitments%rowtype;
  link public.cos_note_task_links%rowtype;
  normalized jsonb;
  fingerprint text;
  field text;
  item jsonb;
  source_project uuid;
  source_archived timestamptz;
  replayed boolean := false;
begin
  request_role := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role',true),''),
    nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'role',
    ''
  );
  if request_role <> 'service_role' then
    raise exception using errcode='42501',message='Task creation is restricted to the service role.';
  end if;
  if p_source_kind is null or p_source_kind not in ('quick','project')
    or p_source_id is null or p_request_id is null
    or pg_catalog.jsonb_typeof(p_task) is distinct from 'object' then
    raise exception using errcode='PT400',message='Invalid note task request.';
  end if;

  -- Only fields explicitly confirmed in the task editor are accepted. No
  -- source note title/body is loaded, copied into details, or put into history.
  for field,item in select key,value from pg_catalog.jsonb_each(p_task) loop
    if field not in ('description','details','status','direction','project_id','area_key',
      'participant_id','deadline','planned_on','next_check_on','planned_start_at',
      'planned_end_at','deadline_at','next_check_at','estimate_minutes') then
      raise exception using errcode='PT400',message='Unsupported task field.';
    end if;
    if item <> 'null'::jsonb then
      if field='estimate_minutes' then
        if pg_catalog.jsonb_typeof(item)<>'number' then
          raise exception using errcode='PT400',message='Invalid task estimate.';
        end if;
        if (item::text)::numeric <> pg_catalog.trunc((item::text)::numeric)
          or (item::text)::numeric not between 1 and 525600 then
          raise exception using errcode='PT400',message='Invalid task estimate.';
        end if;
      elsif pg_catalog.jsonb_typeof(item)<>'string' then
        raise exception using errcode='PT400',message='Invalid task field type.';
      end if;
      if field in ('deadline','planned_on','next_check_on')
        and (p_task->>field) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception using errcode='PT400',message='Invalid task date.';
      end if;
      if field in ('planned_start_at','planned_end_at','deadline_at','next_check_at')
        and (p_task->>field) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode='PT400',message='Invalid task timestamp.';
      end if;
    end if;
  end loop;
  normalized := p_task;
  if p_task->'estimate_minutes' is not null and p_task->'estimate_minutes'<>'null'::jsonb then
    normalized := pg_catalog.jsonb_set(normalized,'{estimate_minutes}',
      pg_catalog.to_jsonb(((p_task->>'estimate_minutes')::numeric)::integer));
  end if;
  begin
    input := pg_catalog.jsonb_populate_record(null::public.commitments,normalized);
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception using errcode='PT400',message='Invalid task value.';
  end;
  input.description := pg_catalog.btrim(input.description);
  input.details := coalesce(input.details,'');
  input.status := coalesce(input.status,'open');
  input.direction := coalesce(input.direction,'internal');
  if input.description is null or input.description !~ '[^[:space:]]'
    or pg_catalog.length(input.description)>2000 or pg_catalog.length(input.details)>64000
    or pg_catalog.length(input.area_key)>100
    or input.status not in ('open','paused','completed','cancelled')
    or input.direction not in ('internal','from_me','to_me')
    or (input.planned_end_at is not null and (input.planned_start_at is null or input.planned_end_at<input.planned_start_at)) then
    raise exception using errcode='PT400',message='Invalid task content or timing.';
  end if;
  -- Defaults and typed dates/UUIDs/timestamps are canonicalized before hashing.
  -- project_id is exactly the user's selection, including null; it never
  -- inherits from a mutable source note during a retry.
  normalized := pg_catalog.jsonb_build_object(
    'description',input.description,'details',input.details,'status',input.status,
    'direction',input.direction,'project_id',input.project_id,'area_key',input.area_key,
    'participant_id',input.participant_id,'deadline',input.deadline,
    'planned_on',input.planned_on,'next_check_on',input.next_check_on,
    'planned_start_at',input.planned_start_at,'planned_end_at',input.planned_end_at,
    'deadline_at',input.deadline_at,'next_check_at',input.next_check_at,
    'estimate_minutes',input.estimate_minutes
  );
  fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(normalized::text,'UTF8')),'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cos_notes_create_task:'||p_request_id::text,0)
  );
  select * into link from public.cos_note_task_links where request_id=p_request_id;
  if found then
    if link.source_kind<>p_source_kind or link.source_id<>p_source_id or link.payload_hash<>fingerprint then
      raise exception using errcode='PT409',message='Request identifier already has different task input.';
    end if;
    replayed := true;
    select * into task from public.commitments where id=link.commitment_id;
  end if;

  -- SHARE locks serialize a new task against concurrent archival/deletion.
  -- An already committed request remains replayable after editing/archival.
  if p_source_kind='quick' then
    select project_id,archived_at into source_project,source_archived
      from public.quick_notes where id=p_source_id for share;
  else
    select project_id,archived_at into source_project,source_archived
      from public.project_notes where id=p_source_id for share;
  end if;
  if not found then
    raise exception using errcode='PT404',message='Source note was not found.';
  end if;
  if not replayed then
    if source_archived is not null then
      raise exception using errcode='PT410',message='Source note is archived.';
    end if;
    begin
      insert into public.commitments(description,details,status,direction,project_id,area_key,
        participant_id,deadline,planned_on,next_check_on,planned_start_at,planned_end_at,
        deadline_at,next_check_at,estimate_minutes)
      values(input.description,input.details,input.status,input.direction,input.project_id,input.area_key,
        input.participant_id,input.deadline,input.planned_on,input.next_check_on,input.planned_start_at,
        input.planned_end_at,input.deadline_at,input.next_check_at,input.estimate_minutes)
      returning * into task;
      insert into public.cos_note_task_links(request_id,source_kind,quick_note_id,project_note_id,
        commitment_id,payload_hash)
      values(p_request_id,p_source_kind,case when p_source_kind='quick' then p_source_id end,
        case when p_source_kind='project' then p_source_id end,task.id,fingerprint);
    exception when foreign_key_violation or check_violation or not_null_violation then
      raise exception using errcode='PT400',message='Invalid task reference or value.';
    end;
  end if;
  return pg_catalog.jsonb_build_object('task',pg_catalog.to_jsonb(task),
    'source',pg_catalog.jsonb_build_object('kind',p_source_kind,'id',p_source_id,'project_id',source_project),
    'replayed',replayed);
end;
$function$;
revoke all privileges on function public.cos_notes_create_task(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cos_notes_create_task(text,uuid,uuid,jsonb) to service_role;

do $assertions$
declare
  target oid := 'public.cos_note_task_links'::regclass;
  fn text := 'public.cos_notes_create_task(text,uuid,uuid,jsonb)';
  role_name text;
begin
  if not exists(select 1 from pg_catalog.pg_class where oid=target and relrowsecurity and relforcerowsecurity) then
    raise exception 'Note task links require enabled and forced RLS.';
  end if;
  foreach role_name in array array['anon','authenticated'] loop
    if pg_catalog.has_table_privilege(role_name,target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(role_name,target,'SELECT,INSERT,UPDATE,REFERENCES')
      or pg_catalog.has_function_privilege(role_name,fn,'EXECUTE') then
      raise exception 'Unexpected note task privilege: %',role_name;
    end if;
  end loop;
  if not pg_catalog.has_table_privilege('service_role',target,'SELECT')
    or not pg_catalog.has_table_privilege('service_role',target,'INSERT')
    or not pg_catalog.has_function_privilege('service_role',fn,'EXECUTE') then
    raise exception 'Missing note task service privilege.';
  end if;
end;
$assertions$;

notify pgrst,'reload schema';
commit;
