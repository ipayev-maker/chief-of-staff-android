-- Only synthetic rows. All changes and trigger history roll back together.
begin;
set local role service_role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
do $smoke$
declare
  project_a uuid; project_b uuid; person uuid; note_a uuid; note_b uuid; box uuid; box_b uuid;
  task_a uuid; action_a uuid:=gen_random_uuid(); action_b uuid:=gen_random_uuid(); action_c uuid:=gen_random_uuid();
  apply_request uuid:=gen_random_uuid(); update_request uuid:=gen_random_uuid(); bad_request uuid:=gen_random_uuid();
  result jsonb; replay jsonb; actions jsonb; doc jsonb; current_revision integer; stamp timestamptz;
  cfg jsonb; owner_chat bigint; owner_user bigint; source_token bigint; captured_id uuid; captured_note uuid; confirmation jsonb;
  before_count bigint; before_history bigint; stage text:='setup'; client_role text; target text;
begin
  insert into public.projects(title) values('Synthetic communication project A') returning id into project_a;
  insert into public.projects(title) values('Synthetic communication project B') returning id into project_b;
  insert into public.participants(name) values('Synthetic communication person') returning id into person;
  insert into public.quick_notes(plain_text,source) values('Synthetic original communication','web') returning id into note_a;
  insert into public.quick_notes(plain_text,source) values('Synthetic second communication','web') returning id into note_b;
  insert into public.cos_communication_inbox(note_id,source_text,source_meta) values(note_a,'Synthetic original communication','{"channel":"telegram","type":"text"}') returning id into box;
  insert into public.cos_communication_inbox(note_id,source_text) values(note_b,'Synthetic second communication') returning id into box_b;
  insert into public.commitments(description,details,direction,project_id,participant_id,deadline,deadline_at)
    values('Existing synthetic task','Keep these details','from_me',project_a,person,'2030-05-12','2030-05-12T10:30:00Z') returning id into task_a;

  stage:='owner-bound capture and delivery deduplication';
  cfg:=public.cos_notes_get_config();
  owner_chat:=(cfg->>'telegramOwnerChatId')::bigint; owner_user:=(cfg->>'telegramOwnerUserId')::bigint;
  source_token:=9000000000000+floor(random()*1000000000)::bigint;
  result:=public.cos_inbox_capture_telegram(source_token,source_token,owner_chat,owner_user,'Synthetic capture text','{"channel":"telegram","type":"text"}');
  captured_id:=(result->'item'->>'id')::uuid; captured_note:=(result->'item'->>'note_id')::uuid;
  replay:=public.cos_inbox_capture_telegram(source_token,source_token,owner_chat,owner_user,'Retry text must not replace original','{"channel":"telegram","type":"text"}');
  if replay->>'duplicate'<>'true' or (replay->'item'->>'id')::uuid<>captured_id or replay->'item'->>'source_text'<>'Synthetic capture text'
    or (select count(*) from public.cos_communication_inbox where note_id=captured_note)<>1 then raise exception 'Capture replay changed source'; end if;
  begin perform public.cos_inbox_capture_telegram(source_token+1,source_token+1,owner_chat,owner_user+1,'Wrong owner synthetic','{}'); raise exception 'Wrong Telegram owner accepted'; exception when insufficient_privilege then null; end;

  stage:='voice caption preservation';
  replay:=public.cos_inbox_capture_telegram(source_token+2,source_token+2,owner_chat,owner_user,'Owner supplied voice caption','{"channel":"telegram","type":"voice"}');
  result:=public.cos_inbox_update((replay->'item'->>'id')::uuid,1,gen_random_uuid(),'{"transcript":"Recognized speech"}');
  if (select plain_text from public.quick_notes where id=(replay->'item'->>'note_id')::uuid)<>'Owner supplied voice caption'
    or result->'item'->>'transcript'<>'Recognized speech' then raise exception 'Voice caption overwritten'; end if;

  stage:='private permissions';
  foreach target in array array['cos_communication_inbox','cos_communication_requests','cos_communication_reply_claims'] loop
    foreach client_role in array array['anon','authenticated'] loop
      if has_table_privilege(client_role,'public.'||target,'SELECT,INSERT,UPDATE,DELETE') then raise exception 'Public inbox access'; end if;
    end loop;
  end loop;

  stage:='claim, lease, transcript preservation';
  result:=public.cos_inbox_update(box,1,update_request,'{"status":"processing"}');
  begin perform public.cos_inbox_update(box,2,gen_random_uuid(),jsonb_build_object('attempt_id',gen_random_uuid(),'proposal','{}'::jsonb)); raise exception 'Wrong attempt token accepted'; exception when sqlstate 'PT409' then null; end;
  if (result->'item'->>'revision')::integer<>2 or result->'item'->>'attempt_id' is null then raise exception 'Missing processing lease'; end if;
  replay:=public.cos_inbox_update(box,1,update_request,'{"status":"processing"}');
  if replay->>'replayed'<>'true' or replay->'item'<>result->'item' then raise exception 'Update replay changed result'; end if;
  begin perform public.cos_inbox_update(box,1,update_request,'{"status":"deferred"}'); raise exception 'Changed request accepted'; exception when sqlstate 'PT409' then null; end;
  begin perform public.cos_inbox_update(box,2,gen_random_uuid(),'{"status":"processing"}'); raise exception 'Live lease stolen'; exception when sqlstate 'PT409' then null; end;
  update public.cos_communication_inbox set processing_started_at=clock_timestamp()-interval '3 minutes' where id=box;
  result:=public.cos_inbox_update(box,2,gen_random_uuid(),'{"status":"processing"}');
  begin perform public.cos_inbox_update(box,2,gen_random_uuid(),'{"status":"ready"}'); raise exception 'Stale worker finished'; exception when sqlstate 'PT409' then null; end;
  result:=public.cos_inbox_update(box,3,gen_random_uuid(),'{"transcript":"Recognized synthetic communication","source_meta":{"audio_path":"111/synthetic/voice.ogg","audio_size_bytes":5},"status":"ready","proposal":{"actions":[]}}');
  if result->'item'->>'source_text'<>'Synthetic original communication' or (select plain_text from public.quick_notes where id=note_a)<>'Recognized synthetic communication'
    or result->'item'->'source_meta'->>'channel'<>'telegram' then raise exception 'Source preservation failed'; end if;
  begin perform public.cos_inbox_update(box,4,gen_random_uuid(),'{"source_meta":{"message_date":"2030-05-12"}}'); raise exception 'Original metadata overwritten'; exception when sqlstate 'PT400' then null; end;

  stage:='transcript does not overwrite edited note';
  update public.quick_notes set plain_text='Owner-edited synthetic note' where id=note_b;
  result:=public.cos_inbox_update(box_b,1,gen_random_uuid(),'{"transcript":"Synthetic transcription after owner edit"}');
  if (select plain_text from public.quick_notes where id=note_b)<>'Owner-edited synthetic note' or result->'item'->>'transcript'<>'Synthetic transcription after owner edit' then raise exception 'Transcript overwrote owner note'; end if;

  stage:='one reply claim without revision change';
  if not public.cos_inbox_claim_reply(box) or public.cos_inbox_claim_reply(box) or (select revision from public.cos_communication_inbox where id=box)<>4 then raise exception 'Reply claim duplicated or changed revision'; end if;

  doc:=jsonb_build_object('goal','','current_state','Confirmed state','next_step','','checkpoint_label','','checkpoint_on',null,
    'entries',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'kind','waiting','text','Wait for approval','person','Synthetic communication person','review_on','2030-05-15','source','Communication inbox','status','open')));
  actions:=jsonb_build_array(
    jsonb_build_object('id',action_a,'kind','task_create','task',jsonb_build_object('description','New confirmed synthetic task','project_id',project_a,'participant_id',person,'deadline','2030-05-12','deadline_at','2030-05-12T10:00:00Z')),
    jsonb_build_object('id',action_b,'kind','task_update','task_id',task_a,'version',1,'patch',jsonb_build_object('description','Updated synthetic task','deadline','2030-05-14','deadline_at','2030-05-14T10:30:00Z')),
    jsonb_build_object('id',action_c,'kind','brief_replace','project_id',project_a,'revision',0,'document',doc));

  stage:='atomic failure of last operation';
  select count(*) into before_count from public.commitments;
  select count(*) into before_history from public.cos_task_history;
  begin
    perform public.cos_inbox_apply(box,4,bad_request,jsonb_set(actions,'{2,revision}','1'));
    raise exception 'Stale brief accepted';
  exception when sqlstate 'PT409' then null; end;
  if (select count(*) from public.commitments)<>before_count or (select count(*) from public.cos_task_history)<>before_history
    or (select cos_version from public.commitments where id=task_a)<>1 or (select revision from public.cos_communication_inbox where id=box)<>4
    or exists(select 1 from public.cos_communication_requests where request_id=bad_request)
    or exists(select 1 from public.cos_note_task_links where request_id=action_a) then raise exception 'Partial mutation survived rollback'; end if;

  stage:='apply whole batch and strict replay';
  result:=public.cos_inbox_apply(box,4,apply_request,actions);
  if result->'item'->>'status'<>'applied' or (result->'item'->>'revision')::integer<>5
    or jsonb_array_length(result->'result'->'tasks')<>2 or jsonb_array_length(result->'result'->'briefs')<>1
    or (select cos_version from public.commitments where id=task_a)<>2
    or (select details from public.commitments where id=task_a)<>'Keep these details'
    or (select document from public.cos_project_briefs where project_id=project_a)<>doc
    or (select count(*) from public.cos_note_task_links where request_id=action_a)<>1 then raise exception 'Batch result incorrect'; end if;
  replay:=public.cos_inbox_apply(box,4,apply_request,actions);
  if replay->>'replayed'<>'true' or replay->'result'<>result->'result' or (select cos_version from public.commitments where id=task_a)<>2 then raise exception 'Replay duplicated application'; end if;
  begin perform public.cos_inbox_apply(box,4,apply_request,'[]'); raise exception 'Changed apply accepted'; exception when sqlstate 'PT409' then null; end;
  begin perform public.cos_inbox_apply(box,5,gen_random_uuid(),'[]'); raise exception 'Applied inbox applied twice'; exception when sqlstate 'PT409' then null; end;

  stage:='archived source and stale task rejection';
  result:=public.cos_inbox_update(box_b,2,gen_random_uuid(),'{"status":"ready"}');
  update public.quick_notes set archived_at=now() where id=note_b;
  begin perform public.cos_inbox_apply(box_b,3,gen_random_uuid(),'[]'); raise exception 'Archived source applied'; exception when sqlstate 'PT410' then null; end;
  update public.quick_notes set archived_at=null where id=note_b;
  begin perform public.cos_inbox_apply(box_b,3,gen_random_uuid(),jsonb_build_array(actions->1)); raise exception 'Stale task applied'; exception when sqlstate 'PT409' then null; end;
  begin perform public.cos_inbox_apply(box_b,3,gen_random_uuid(),jsonb_build_array(jsonb_set(actions->1,'{version}','2'),jsonb_set(actions->1,'{version}','2'))); raise exception 'Duplicate actions applied'; exception when sqlstate 'PT400' then null; end;
  begin perform public.cos_inbox_task_patch(task_a,2,'{"cos_version":20}'); raise exception 'Protected task field accepted'; exception when sqlstate 'PT400' then null; end;
  begin perform public.cos_inbox_task_patch(task_a,2,'{"deadline":"2030-02-30"}'); raise exception 'Invalid date accepted'; exception when sqlstate 'PT400' then null; end;
  begin perform public.cos_inbox_task_patch(task_a,2,'{"details":null}'); raise exception 'Null required field accepted'; exception when sqlstate 'PT400' then null; end;
  confirmation:=jsonb_build_object('revision',3,'proposal',jsonb_build_object('changes','[]'::jsonb));
  update_request:=gen_random_uuid();
  result:=public.cos_inbox_apply(box_b,3,update_request,'[]',confirmation);
  replay:=public.cos_inbox_apply(box_b,3,update_request,'[]',confirmation);
  if replay->>'replayed'<>'true' then raise exception 'Confirmation replay rejected'; end if;
  begin perform public.cos_inbox_apply(box_b,3,update_request,'[]',confirmation||'{"changed":true}'::jsonb); raise exception 'Changed confirmation replay accepted'; exception when sqlstate 'PT409' then null; end;
  begin perform public.cos_inbox_apply(box,3,update_request,'[]',confirmation); raise exception 'Cross-item confirmation replay accepted'; exception when sqlstate 'PT409' then null; end;
  if result->'item'->>'status'<>'applied' or result->'item'->'proposal'->'changes'<>'[]'::jsonb or result->'item'->'applied_result' is null then raise exception 'Note-only finish or confirmed history failed'; end if;

  stage:='canonical confirmation replay after baseline changes';
  result:=public.cos_inbox_update(captured_id,1,gen_random_uuid(),'{"status":"ready"}');
  confirmation:=jsonb_build_object('revision',2,'proposal',jsonb_build_object('changes',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'kind','project_state','text','Reviewed final state'))));
  update_request:=gen_random_uuid();
  actions:=jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'kind','brief_replace','project_id',project_b,'revision',0,'document',doc));
  result:=public.cos_inbox_apply(captured_id,2,update_request,actions,confirmation);
  perform public.cos_save_project_brief(project_b,1,gen_random_uuid(),jsonb_set(doc,'{current_state}','"Later confirmed state"'));
  replay:=public.cos_inbox_apply(captured_id,2,update_request,'[]',confirmation);
  if replay->>'replayed'<>'true' or replay->'result'<>result->'result'
    or replay->'item'->'proposal'->'changes'<>confirmation->'proposal'->'changes'
    or (select document->>'current_state' from public.cos_project_briefs where project_id=project_b)<>'Later confirmed state' then raise exception 'Canonical replay mutated later state or lost reviewed changes'; end if;

  stage:='service JWT gate';
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin perform public.cos_inbox_update(box,5,gen_random_uuid(),'{"status":"ready"}'); raise exception 'Client JWT accepted'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
exception when others then
  raise exception 'Communication inbox smoke failed at %: % (%)',stage,sqlerrm,sqlstate;
end;
$smoke$;
set local role anon;
do $anon$
begin
  begin perform 1 from public.cos_communication_inbox; raise exception 'Anonymous inbox access'; exception when insufficient_privilege then null; end;
  begin perform public.cos_inbox_apply(gen_random_uuid(),1,gen_random_uuid(),'[]'); raise exception 'Anonymous apply access'; exception when insufficient_privilege then null; end;
end;
$anon$;
rollback;
select 'PASS: private inbox, lease and stale-worker CAS, source preservation, reply dedupe, atomic task+brief application, replay conflicts, source guards and no real changes' as result;
