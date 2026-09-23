-- Run after note-task-links.sql from the database-owner SQL session.
-- Only synthetic projects, notes, tasks and history are used. Everything is
-- rolled back; no real identifiers, note contents or secrets are returned.
begin;
set local role service_role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claims = '{"role":"service_role"}';

do $smoke$
declare
  project_a uuid;
  project_b uuid;
  participant uuid;
  quick uuid;
  project_note uuid;
  request_a uuid := gen_random_uuid();
  request_b uuid := gen_random_uuid();
  request_c uuid := gen_random_uuid();
  bad_request uuid := gen_random_uuid();
  rollback_request uuid := gen_random_uuid();
  task_a uuid;
  rollback_task uuid;
  result jsonb;
  replay jsonb;
  payload jsonb;
  invalid_input jsonb;
  quick_before jsonb;
  project_before jsonb;
  role_name text;
  stage text := 'permissions';
  failure_code text;
begin
  if not exists(select 1 from pg_catalog.pg_class
    where oid='public.cos_note_task_links'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'RLS must be enabled and forced.';
  end if;
  foreach role_name in array array['anon','authenticated'] loop
    if pg_catalog.has_table_privilege(role_name,'public.cos_note_task_links','SELECT,INSERT,UPDATE,DELETE')
      or pg_catalog.has_any_column_privilege(role_name,'public.cos_note_task_links','SELECT,INSERT,UPDATE,REFERENCES')
      or pg_catalog.has_function_privilege(role_name,'public.cos_notes_create_task(text,uuid,uuid,jsonb)','EXECUTE') then
      raise exception 'Unexpected public note-task access.';
    end if;
  end loop;

  stage := 'synthetic source setup';
  insert into public.projects(title) values('Synthetic note-task smoke source') returning id into project_a;
  insert into public.projects(title) values('Synthetic note-task smoke override') returning id into project_b;
  insert into public.participants(name) values('Synthetic note-task smoke participant') returning id into participant;
  insert into public.quick_notes(title,plain_text,project_id,source)
    values('Synthetic quick note','PRIVATE_SOURCE_ONLY_DO_NOT_COPY_7d1b',project_a,'web') returning id into quick;
  insert into public.project_notes(project_id,title,plain_text,content_json)
    values(project_a,'','PROJECT_SOURCE_ONLY_DO_NOT_COPY_7d1b','{"type":"doc","content":[]}') returning id into project_note;
  select to_jsonb(n) into quick_before from public.quick_notes n where id=quick;
  select to_jsonb(n) into project_before from public.project_notes n where id=project_note;
  payload := jsonb_build_object('description','Confirmed synthetic task','project_id',project_b,
    'participant_id',participant,'deadline','2030-05-12','deadline_at','2030-05-12T12:00:00Z',
    'planned_on','2030-05-11','planned_start_at','2030-05-11T10:00:00Z',
    'planned_end_at','2030-05-11T11:00:00Z','estimate_minutes',60);

  stage := 'create private-note task with explicit project override';
  result := public.cos_notes_create_task('quick',quick,request_a,payload);
  task_a := (result->'task'->>'id')::uuid;
  if task_a is null or (result->>'replayed')::boolean
    or result->'task'->>'details'<>'' or result->'task'->>'description'<>'Confirmed synthetic task'
    or (result->'task'->>'project_id')::uuid<>project_b
    or (result->'source'->>'project_id')::uuid<>project_a
    or result->'task'->>'direction'<>'internal' or result->'task'->>'status'<>'open'
    or not exists(select 1 from public.cos_note_task_links
      where request_id=request_a and source_kind='quick' and source_id=quick
        and quick_note_id=quick and project_note_id is null and commitment_id=task_a) then
    raise exception 'Task or durable source link was not created correctly.';
  end if;
  if exists(select 1 from public.cos_task_history h where h.task_id=task_a
    and to_jsonb(h)::text like '%PRIVATE_SOURCE_ONLY_DO_NOT_COPY_7d1b%') then
    raise exception 'Private source content leaked into task history.';
  end if;
  if (select to_jsonb(n) from public.quick_notes n where id=quick) is distinct from quick_before then
    raise exception 'Creating a task changed the source note.';
  end if;

  stage := 'normalized retry';
  replay := public.cos_notes_create_task('quick',quick,request_a,
    payload||jsonb_build_object('description',' Confirmed synthetic task ','details','',
      'status','open','direction','internal','area_key',null,'next_check_on',null,
      'next_check_at',null,'deadline_at','2030-05-12T14:00:00+02:00'));
  if not (replay->>'replayed')::boolean or (replay->'task'->>'id')::uuid<>task_a then
    raise exception 'Canonical retry created a different task.';
  end if;

  stage := 'same key changed payload or source';
  begin
    perform public.cos_notes_create_task('quick',quick,request_a,payload||'{"description":"Changed task"}'::jsonb);
    raise exception 'Changed payload reused the request identifier.';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.cos_notes_create_task('project',project_note,request_a,payload);
    raise exception 'Changed source reused the request identifier.';
  exception when sqlstate 'PT409' then null; end;

  stage := 'multiple tasks per source and project-note source';
  result := public.cos_notes_create_task('quick',quick,request_b,'{"description":"Second confirmed task"}');
  if (result->'task'->>'id')::uuid=task_a or result->'task'->>'project_id' is not null
    or (select count(*) from public.cos_note_task_links where source_kind='quick' and source_id=quick)<>2 then
    raise exception 'Different requests did not produce independent tasks.';
  end if;
  result := public.cos_notes_create_task('project',project_note,request_c,
    jsonb_build_object('description','Confirmed project note task','details','Explicitly confirmed details','project_id',project_a));
  if (result->>'replayed')::boolean or result->'task'->>'details'<>'Explicitly confirmed details'
    or not exists(select 1 from public.cos_note_task_links
      where request_id=request_c and source_kind='project' and source_id=project_note
        and project_note_id=project_note and quick_note_id is null)
    or (select to_jsonb(n) from public.project_notes n where id=project_note) is distinct from project_before then
    raise exception 'Project note creation or source immutability failed.';
  end if;

  stage := 'archive edit and replay';
  update public.quick_notes set plain_text='Edited synthetic private note',project_id=null,archived_at=now() where id=quick;
  replay := public.cos_notes_create_task('quick',quick,request_a,payload);
  if not (replay->>'replayed')::boolean or (replay->'task'->>'id')::uuid<>task_a
    or replay->'task'->>'description'<>'Confirmed synthetic task'
    or (replay->'task'->>'project_id')::uuid<>project_b then
    raise exception 'Edited or archived source broke a committed retry.';
  end if;
  begin
    perform public.cos_notes_create_task('quick',quick,gen_random_uuid(),payload);
    raise exception 'Archived source accepted a new request.';
  exception when sqlstate 'PT410' then null; end;
  begin
    perform public.cos_notes_create_task('project',gen_random_uuid(),gen_random_uuid(),payload);
    raise exception 'Missing source accepted a new request.';
  exception when sqlstate 'PT404' then null; end;

  stage := 'strict task validation';
  for invalid_input in select value from jsonb_array_elements('[
    {"description":" "},{"description":"Synthetic","raw_text":"must reject"},
    {"description":"Synthetic","status":"unknown"},{"description":"Synthetic","estimate_minutes":0},
    {"description":"Synthetic","estimate_minutes":1.5},{"description":"Synthetic","estimate_minutes":"60"},
    {"description":"Synthetic","deadline":"2030-02-30"},{"description":"Synthetic","deadline":"tomorrow"},
    {"description":"Synthetic","planned_end_at":"2030-05-12T10:00:00Z"},
    {"description":"Synthetic","planned_start_at":"2030-05-12T11:00:00Z","planned_end_at":"2030-05-12T10:00:00Z"},
    {"description":"Synthetic","deadline_at":"2030-05-12T24:00:00Z"},
    {"description":"Synthetic","project_id":"invalid-uuid"}
  ]'::jsonb) loop
    begin
      perform public.cos_notes_create_task('project',project_note,bad_request,invalid_input);
      raise exception 'Invalid task input was accepted.';
    exception when sqlstate 'PT400' then null; end;
  end loop;

  stage := 'foreign-key failure leaves no task link or trigger history';
  begin
    perform public.cos_notes_create_task('project',project_note,bad_request,
      jsonb_build_object('description','ROLLBACK_FAILED_REFERENCE_7d1b','project_id',project_a,'participant_id',gen_random_uuid()));
    raise exception 'Missing participant reference was accepted.';
  exception when sqlstate 'PT400' then null; end;
  if exists(select 1 from public.cos_note_task_links where request_id=bad_request)
    or exists(select 1 from public.commitments where description='ROLLBACK_FAILED_REFERENCE_7d1b')
    or exists(select 1 from public.cos_task_history where after_data->>'description'='ROLLBACK_FAILED_REFERENCE_7d1b') then
    raise exception 'Failed creation leaked task, link or history.';
  end if;

  stage := 'task link and history roll back together';
  begin
    result := public.cos_notes_create_task('project',project_note,rollback_request,
      jsonb_build_object('description','ROLLBACK_FULL_REQUEST_7d1b','project_id',project_a));
    rollback_task := (result->'task'->>'id')::uuid;
    raise exception using errcode='P0002',message='Synthetic rollback.';
  exception when no_data_found then null; end;
  if exists(select 1 from public.cos_note_task_links where request_id=rollback_request)
    or exists(select 1 from public.commitments where id=rollback_task)
    or exists(select 1 from public.cos_task_history where task_id=rollback_task) then
    raise exception 'Task link and history did not roll back together.';
  end if;

  stage := 'service JWT gate';
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.cos_notes_create_task('project',project_note,gen_random_uuid(),payload);
    raise exception 'A non-service JWT was accepted.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
exception when others then
  failure_code := sqlstate;
  raise exception using errcode='P0001',
    message='Note task smoke failed at '||stage||' (SQLSTATE '||failure_code||').';
end;
$smoke$;

set local role anon;
do $anon$
begin
  begin
    perform 1 from public.cos_note_task_links limit 1;
    raise exception 'Anonymous note-task reads were allowed.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.cos_notes_create_task('quick',gen_random_uuid(),gen_random_uuid(),'{"description":"Synthetic"}');
    raise exception 'Anonymous task RPC invocation was allowed.';
  exception when insufficient_privilege then null; end;
end;
$anon$;
rollback;
select 'PASS: private links, confirmed fields only, both sources, canonical replay, conflicts, multiple tasks, archive/missing guards, strict validation, atomic rollback and service-only access; all synthetic rows rolled back' as result;
