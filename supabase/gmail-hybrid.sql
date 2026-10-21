-- One captured source note may have independent, owner-reviewable suggestions.
-- Primary captures stay unique; only Gmail review children share their source.
begin;
alter table public.cos_communication_inbox drop constraint if exists cos_communication_inbox_note_id_key;
create unique index if not exists cos_inbox_primary_note_idx on public.cos_communication_inbox(note_id) where not (source_meta ? 'review_parent_id');
create unique index if not exists cos_inbox_mail_review_idx on public.cos_communication_inbox((source_meta->>'review_parent_id'),(source_meta->>'review_change_id')) where source_meta ? 'review_parent_id';

create or replace function public.cos_gmail_deliver_hybrid(p_id uuid,p_revision integer,p_request_id uuid,p_actions jsonb,p_reviews jsonb)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog,public,pg_temp
as $fn$
declare item public.cos_communication_inbox%rowtype; review jsonb; result jsonb; legacy public.commitments%rowtype; legacy_id uuid; skipped boolean:=false;
begin
 perform public.cos_inbox_require_service();
 select * into item from public.cos_communication_inbox where id=p_id for update;
 if not found then raise exception using errcode='PT404',message='inbox_not_found';end if;
 if item.status='applied' then return jsonb_build_object('item',to_jsonb(item),'replayed',true);end if;
 if item.revision<>p_revision or item.status<>'ready' or item.source_meta->>'type' is distinct from 'gmail' or item.source_meta->>'delivery' is distinct from 'tasks'
   or item.source_meta->>'superseded'='true' then raise exception using errcode='PT409',message='inbox_revision_conflict';end if;
 if jsonb_typeof(p_reviews) is distinct from 'array' or jsonb_array_length(p_reviews)>31 then raise exception using errcode='PT400',message='invalid_mail_reviews';end if;
 if jsonb_typeof(p_actions) is distinct from 'array' or exists(select 1 from jsonb_array_elements(p_actions) a where a->>'kind' is distinct from 'task_create') then raise exception using errcode='PT400',message='invalid_automatic_mail_action';end if;
 legacy_id:=(item.source_meta->>'hybrid_legacy_task_id')::uuid;
 if legacy_id is not null then
   select * into legacy from public.commitments where id=legacy_id for update;
   skipped:=not found or legacy.deleted_at is not null or legacy.status<>'open' or legacy.cos_version is distinct from (item.source_meta->>'hybrid_legacy_task_version')::integer;
   if not skipped and exists(select 1 from public.time_entries where commitment_id=legacy_id and source='timer' and ended_at is null) then skipped:=true;end if;
   if skipped then
     update public.cos_communication_inbox set status='applied',applied_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp(),source_meta=source_meta||'{"hybrid_skipped":"legacy_changed"}'::jsonb where id=p_id returning * into item;
     return jsonb_build_object('item',to_jsonb(item),'skipped',true);
   end if;
 end if;
 -- The existing transaction validates and applies only new, grounded tasks.
 result:=public.cos_inbox_apply(p_id,p_revision,p_request_id,p_actions,jsonb_build_object('mode','gmail_hybrid','review_ids',(select coalesce(jsonb_agg(r->'id'),'[]') from jsonb_array_elements(p_reviews) r)));
 for review in select value from jsonb_array_elements(p_reviews) loop
   if jsonb_typeof(review->'proposal') is distinct from 'object' or jsonb_typeof(review->'proposal'->'changes') is distinct from 'array'
     or jsonb_array_length(review->'proposal'->'changes')>1 then raise exception using errcode='PT400',message='invalid_mail_review';end if;
   if jsonb_array_length(review->'proposal'->'changes')=1 and review->>'id' is distinct from review->'proposal'->'changes'->0->>'id' then raise exception using errcode='PT400',message='invalid_mail_review_id';end if;
   insert into public.cos_communication_inbox(id,note_id,source_text,source_meta,proposal,status,created_at)
     values((review->>'id')::uuid,item.note_id,item.source_text,
       (item.source_meta-'hybrid_legacy_task_id'-'hybrid_legacy_task_version')||jsonb_build_object('delivery','review','review_parent_id',item.id,'review_change_id',review->>'id'),
       review->'proposal','ready',item.created_at);
 end loop;
 if legacy_id is not null then
   update public.commitments set status='cancelled',deleted_at=clock_timestamp() where id=legacy_id and cos_version=legacy.cos_version;
 end if;
 return result||jsonb_build_object('reviews_created',jsonb_array_length(p_reviews));
end;
$fn$;

create or replace function public.cos_gmail_prepare_hybrid_backfill()
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog,public,pg_temp
as $fn$
declare item public.cos_communication_inbox%rowtype; task public.commitments%rowtype; original jsonb; count_prepared integer:=0; config jsonb;
begin
 perform public.cos_inbox_require_service();
 select settings into config from public.cos_gmail_connection where id='owner' for update;
 if config->>'hybrid_backfill' is distinct from 'true' then return jsonb_build_object('prepared',0);end if;
 for item in select * from public.cos_communication_inbox where status='applied' and source_meta->>'type'='gmail' and source_meta->>'delivery'='tasks'
   and proposal->'analysis'->>'mail_fallback'='true' and not(source_meta ? 'hybrid_legacy_task_id') order by created_at,id for update loop
   original:=item.applied_result->'tasks'->0;
   if original is null or jsonb_array_length(coalesce(item.applied_result->'tasks','[]'))<>1 then continue;end if;
   select * into task from public.commitments where id=(original->>'id')::uuid for update;
   if not found or task.deleted_at is not null or task.status<>'open' or task.cos_version is distinct from (original->>'cos_version')::integer
     or task.description is distinct from original->>'description' or task.details is distinct from original->>'details'
     or task.description not like 'Разобрать письмо:%' then continue;end if;
   if exists(select 1 from public.time_entries where commitment_id=task.id and source='timer' and ended_at is null) then continue;end if;
   -- Preserve processed IDs before resetting analysis; no mailbox reimport.
   update public.cos_gmail_threads t set processed_ids=(select coalesce(jsonb_agg(distinct m),'[]'::jsonb) from jsonb_array_elements(coalesce(t.processed_ids,'[]')||coalesce(item.source_meta->'new_message_ids','[]')) m)
     where t.thread_id=item.source_meta->>'thread_id';
   update public.cos_communication_inbox set status='captured',applied_at=null,revision=revision+1,updated_at=clock_timestamp(),processing_started_at=null,attempt_id=null,error_code=null,
     proposal=jsonb_build_object('corrections',coalesce(proposal->'corrections','[]'::jsonb)),
     source_meta=source_meta||jsonb_build_object('hybrid_legacy_task_id',task.id,'hybrid_legacy_task_version',task.cos_version)
     where id=item.id;
   count_prepared:=count_prepared+1;
 end loop;
 update public.cos_gmail_connection set settings=settings-'hybrid_backfill' where id='owner';
 return jsonb_build_object('prepared',count_prepared);
end;
$fn$;
revoke all on function public.cos_gmail_deliver_hybrid(uuid,integer,uuid,jsonb,jsonb),public.cos_gmail_prepare_hybrid_backfill() from public,anon,authenticated;
grant execute on function public.cos_gmail_deliver_hybrid(uuid,integer,uuid,jsonb,jsonb),public.cos_gmail_prepare_hybrid_backfill() to service_role;
commit;
