-- Synthetic transactions: source, tasks, meetings, receipts and triggers roll back.
begin;
set local role service_role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
do $test$
declare
  note_id uuid; inbox_id uuid; meeting_id uuid:=gen_random_uuid(); task_action uuid:=gen_random_uuid();
  request_id uuid:=gen_random_uuid(); actions jsonb; result jsonb; replay jsonb; task_id uuid;
begin
  if has_function_privilege('anon','public.cos_inbox_cancel_created(uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.cos_inbox_cancel_created(uuid,uuid)','EXECUTE') then
    raise exception 'Cancel RPC exposed to clients';
  end if;
  insert into public.quick_notes(plain_text,source) values('Synthetic automatic creation verification','web') returning id into note_id;
  insert into public.cos_communication_inbox(note_id,source_text,status)
    values(note_id,'Synthetic automatic creation verification','ready') returning id into inbox_id;
  actions:=jsonb_build_array(
    jsonb_build_object('id',meeting_id,'kind','meeting_create','meeting',jsonb_build_object(
      'title','Synthetic appointment','project_id',null,'starts_at','2035-10-01T06:15:00.000Z',
      'ends_at','2035-10-01T06:45:00.000Z','agenda','Synthetic source')),
    jsonb_build_object('id',task_action,'kind','task_create','task',jsonb_build_object(
      'description','Synthetic task','details','Synthetic source','direction','internal','status','open',
      'project_id',null,'participant_id',null,'deadline',null,'deadline_at',null,'next_check_on',null,
      'planned_on','2035-10-02','planned_start_at','2035-10-02T06:30:00Z','planned_end_at',null)));
  result:=public.cos_inbox_apply(inbox_id,1,request_id,actions);
  task_id:=(result->'result'->'tasks'->0->>'id')::uuid;
  if task_id is null or jsonb_array_length(result->'result'->'meetings')<>1 then raise exception 'Mixed creation failed'; end if;
  replay:=public.cos_inbox_apply(inbox_id,1,request_id,actions);
  if replay->>'replayed'<>'true' then raise exception 'Creation replay failed'; end if;
  begin
    perform public.cos_inbox_cancel_created(inbox_id,gen_random_uuid());
    raise exception 'Foreign entity cancellation accepted';
  exception when sqlstate 'PT400' then null;
  end;
  update public.meetings set title='Edited synthetic appointment' where id=meeting_id;
  begin
    perform public.cos_inbox_cancel_created(inbox_id,meeting_id);
    raise exception 'Stale meeting cancellation accepted';
  exception when sqlstate 'PT409' then null;
  end;
  update public.meetings set title='Synthetic appointment' where id=meeting_id;
  perform public.cos_inbox_cancel_created(inbox_id,meeting_id);
  perform public.cos_inbox_cancel_created(inbox_id,task_action);
  if (select status from public.meetings where id=meeting_id)<>'cancelled'
    or (select status from public.commitments where id=task_id)<>'cancelled' then raise exception 'Cancellation failed'; end if;
  replay:=public.cos_inbox_cancel_created(inbox_id,task_action);
  if replay->>'replayed'<>'true' then raise exception 'Cancellation replay failed'; end if;
  -- Reopening later must not make an old delivery cancel it again.
  update public.commitments set status='open' where id=task_id;
  perform public.cos_inbox_cancel_created(inbox_id,task_action);
  if (select status from public.commitments where id=task_id)<>'open' then raise exception 'Old cancellation overwrote reopening'; end if;
end;
$test$;
rollback;
