-- Synthetic records only; the entire test rolls back, including trigger history.
begin;
set local role service_role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
do $test$
declare
  note_id uuid; inbox_id uuid; meeting_id uuid:=gen_random_uuid(); request_id uuid:=gen_random_uuid();
  actions jsonb; result jsonb; replay jsonb; invalid jsonb;
begin
  if has_function_privilege('anon','public.cos_inbox_apply(uuid,integer,uuid,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.cos_inbox_apply(uuid,integer,uuid,jsonb,jsonb)','EXECUTE') then
    raise exception 'Inbox apply exposed to public roles';
  end if;
  insert into public.quick_notes(plain_text,source) values('Synthetic calendar meeting verification','web') returning id into note_id;
  insert into public.cos_communication_inbox(note_id,source_text,status)
    values(note_id,'Synthetic calendar meeting verification','ready') returning id into inbox_id;
  actions:=jsonb_build_array(jsonb_build_object('id',meeting_id,'kind','meeting_create','meeting',jsonb_build_object(
    'title','Synthetic appointment','project_id',null,'starts_at','2035-10-01T06:15:00.000Z',
    'ends_at','2035-10-01T06:45:00.000Z','agenda','Synthetic source')));
  invalid:=jsonb_set(actions,'{0,meeting,ends_at}','"2035-10-01T06:14:00.000Z"');
  begin
    perform public.cos_inbox_apply(inbox_id,1,gen_random_uuid(),invalid);
    raise exception 'Invalid interval accepted';
  exception when sqlstate 'PT400' then null;
  end;
  result:=public.cos_inbox_apply(inbox_id,1,request_id,actions);
  if result->'result'->'meetings'->0->>'id'<>meeting_id::text
    or jsonb_array_length(result->'result'->'tasks')<>0
    or not exists(select 1 from public.meetings where id=meeting_id and starts_at='2035-10-01T06:15:00Z'::timestamptz and status='scheduled') then
    raise exception 'Meeting was not applied correctly';
  end if;
  replay:=public.cos_inbox_apply(inbox_id,1,request_id,actions);
  if replay->>'replayed'<>'true' or (select count(*) from public.meetings where id=meeting_id)<>1 then
    raise exception 'Meeting replay created a duplicate';
  end if;
end;
$test$;
rollback;
