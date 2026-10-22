begin;
set local role service_role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare original_id uuid;request_id uuid:=gen_random_uuid();result jsonb;replayed jsonb;followup_id uuid;begin
 insert into public.commitments(description,direction,status,area_key,deadline) values('Synthetic completion test','internal','open','work','2030-01-01') returning id into original_id;
 result:=public.cos_task_complete_wait(original_id,1,request_id,'{"description":"Synthetic edited task"}');
 followup_id:=(result->'followup'->>'id')::uuid;
 if not exists(select 1 from public.commitments where id=original_id and status='completed' and description='Synthetic edited task') then raise exception 'source not completed with edits';end if;
 if not exists(select 1 from public.commitments where id=followup_id and status='open' and direction='to_me' and area_key='work' and deadline is null and next_check_at between now()+interval '2 hours 59 minutes' and now()+interval '3 hours 1 minute') then raise exception 'invalid followup';end if;
 replayed:=public.cos_task_complete_wait(original_id,1,request_id,'{"description":"Synthetic edited task"}');
 if replayed->'followup'->>'id'<>followup_id::text or (replayed->>'replayed')::boolean is not true then raise exception 'retry not idempotent';end if;
 replayed:=public.cos_task_complete_wait(original_id,1,gen_random_uuid(),'{"description":"Synthetic edited task"}');
 if replayed->'followup'->>'id'<>followup_id::text then raise exception 'double click created another followup';end if;
 begin
  perform public.cos_task_complete_wait(original_id,1,request_id,'{"description":"Changed request"}');
  raise exception 'conflicting retry accepted';
 exception when sqlstate 'PT409' then null;end;
 if has_function_privilege('anon','public.cos_task_complete_wait(uuid,integer,uuid,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.cos_task_complete_wait(uuid,integer,uuid,jsonb)','EXECUTE') then raise exception 'public execution permitted';end if;
 if exists(select 1 from public.cos_task_wait_requests where source_task_id=original_id group by source_task_id having count(*)<>1) then raise exception 'duplicate receipts';end if;
end $$;
rollback;
