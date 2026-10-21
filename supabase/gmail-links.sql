-- Explicit owner links belong to a conversation and survive new replies.
begin;
alter table public.cos_gmail_threads add column if not exists links_revision integer not null default 0 check(links_revision>=0);
create table if not exists public.cos_gmail_thread_participants (
  thread_id text not null references public.cos_gmail_threads(thread_id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  position integer not null check(position between 1 and 30),
  primary key(thread_id,participant_id), unique(thread_id,position)
);
create index if not exists cos_gmail_thread_participants_person_idx on public.cos_gmail_thread_participants(participant_id,thread_id);
create index if not exists cos_gmail_threads_project_idx on public.cos_gmail_threads(project_id,updated_at desc) where inbox_id is not null;
alter table public.cos_gmail_thread_participants enable row level security;
revoke all on public.cos_gmail_thread_participants from public,anon,authenticated;
grant select,insert,update,delete on public.cos_gmail_thread_participants to service_role;

create or replace function public.cos_gmail_set_links(p_thread_id text,p_project_id uuid,p_participant_ids uuid[],p_revision integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $fn$
declare t public.cos_gmail_threads; previous uuid[];
begin
  perform public.cos_inbox_require_service();
  if p_revision is null or p_revision<0 or p_participant_ids is null or cardinality(p_participant_ids)>30
    or array_position(p_participant_ids,null) is not null
    or cardinality(p_participant_ids)<>(select count(distinct x) from unnest(p_participant_ids) x) then
    raise exception using errcode='PT400',message='invalid_links';
  end if;
  select * into t from public.cos_gmail_threads where thread_id=p_thread_id for update;
  if not found or t.inbox_id is null then raise exception using errcode='PT404',message='thread_unavailable'; end if;
  select coalesce(array_agg(participant_id order by position),'{}'::uuid[]) into previous
    from public.cos_gmail_thread_participants where thread_id=p_thread_id;
  -- A retry of an already saved value is harmless even with the old revision.
  if t.links_revision>0 and t.project_id is not distinct from p_project_id and previous=p_participant_ids then
    return jsonb_build_object('project_id',t.project_id,'participant_ids',previous,'revision',t.links_revision);
  end if;
  if t.links_revision<>p_revision then raise exception using errcode='PT409',message='links_conflict'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and (status='active' or id=t.project_id)) then
    raise exception using errcode='PT422',message='invalid_project';
  end if;
  if exists(select 1 from unnest(p_participant_ids) x where not exists(select 1 from public.participants where id=x)) then
    raise exception using errcode='PT422',message='invalid_participant';
  end if;
  delete from public.cos_gmail_thread_participants where thread_id=p_thread_id;
  insert into public.cos_gmail_thread_participants(thread_id,participant_id,position)
    select p_thread_id,x,ordinality::integer from unnest(p_participant_ids) with ordinality as p(x,ordinality);
  update public.cos_gmail_threads set project_id=p_project_id,links_revision=links_revision+1 where thread_id=p_thread_id returning * into t;
  return jsonb_build_object('project_id',t.project_id,'participant_ids',p_participant_ids,'revision',t.links_revision);
end;
$fn$;
revoke all on function public.cos_gmail_set_links(text,uuid,uuid[],integer) from public,anon,authenticated;
grant execute on function public.cos_gmail_set_links(text,uuid,uuid[],integer) to service_role;
commit;
