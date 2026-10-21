-- Repair only untouched review children that targeted their own replaced legacy
-- placeholder. Reuse validated quotes; do not call the model or change tasks.
begin;
do $repair$
declare p public.cos_communication_inbox%rowtype;c public.cos_communication_inbox%rowtype;change jsonb;fixed_proposal jsonb;
begin
 for p in select * from public.cos_communication_inbox i where i.status='applied' and i.source_meta ? 'hybrid_legacy_task_id'
   and jsonb_array_length(coalesce(i.applied_result->'tasks','[]'))=0
   and exists(select 1 from public.cos_communication_inbox r where r.source_meta->>'review_parent_id'=i.id::text)
   and not exists(select 1 from public.cos_communication_inbox r where r.source_meta->>'review_parent_id'=i.id::text and
     (r.revision<>1 or r.status<>'ready' or jsonb_array_length(r.proposal->'changes')<>1 or r.proposal->'changes'->0->>'task_id' is distinct from i.source_meta->>'hybrid_legacy_task_id'))
   order by i.id for update loop
   perform 1 from public.cos_communication_inbox where source_meta->>'review_parent_id'=p.id::text for update;
   if not exists(select 1 from public.commitments where id=(p.source_meta->>'hybrid_legacy_task_id')::uuid and deleted_at is not null and status='cancelled' and cos_version=(p.source_meta->>'hybrid_legacy_task_version')::integer+1) then continue;end if;
   fixed_proposal:=jsonb_set(jsonb_set(p.proposal,'{changes}','[]'::jsonb),'{context}',jsonb_build_object('tasks','[]'::jsonb,'briefs','[]'::jsonb));
   for c in select * from public.cos_communication_inbox where source_meta->>'review_parent_id'=p.id::text loop
     if c.revision<>1 or c.status<>'ready' then raise exception 'Concurrent review change';end if;
     change:=c.proposal->'changes'->0;
     change:=change||jsonb_build_object('id',gen_random_uuid(),'kind','task_create','task_id',null,'task_version',null,'before',null,'status','open','mail_review_reason',null);
     if change->>'text' like 'Разобрать письмо:%' then change:=jsonb_set(change,'{text}',change->'evidence');end if;
     fixed_proposal:=jsonb_set(fixed_proposal,'{changes}',fixed_proposal->'changes'||jsonb_build_array(change));
     update public.cos_communication_inbox set status='deferred',revision=revision+1,source_meta=source_meta||'{"superseded":true}'::jsonb,updated_at=clock_timestamp() where id=c.id;
   end loop;
   fixed_proposal:=jsonb_set(fixed_proposal,'{analysis,id}',to_jsonb(gen_random_uuid()));
   update public.cos_communication_inbox set status='ready',applied_at=null,revision=revision+1,updated_at=clock_timestamp(),proposal=fixed_proposal,
     source_meta=(source_meta-'hybrid_legacy_task_id'-'hybrid_legacy_task_version')||jsonb_build_object('hybrid_replaced_task_id',p.source_meta->>'hybrid_legacy_task_id','hybrid_placeholder_repaired',true)
     where id=p.id;
 end loop;
end;
$repair$;
commit;
