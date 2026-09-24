-- Apply after commitments.deleted_at has been added by the release migration.
-- Logical deletion keeps task history, time records, media and note request receipts.
begin;

create or replace function public.cos_delete_task(p_id uuid, p_version integer)
returns jsonb
language plpgsql
security invoker
-- Existing task risk triggers call unqualified public helper names.
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  task public.commitments%rowtype;
  request_role text;
begin
  request_role := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role',true),''),
    nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'role',
    ''
  );
  if request_role <> 'service_role' then
    raise exception using errcode='42501',message='task_delete_forbidden';
  end if;
  if p_id is null or p_version is null or p_version < 1 then
    raise exception using errcode='PT400',message='invalid_task_delete';
  end if;

  select * into task from public.commitments where id=p_id for update;
  if not found then
    raise exception using errcode='PT404',message='task_not_found';
  end if;
  -- A retry after a lost response confirms the same deletion without another write.
  if task.deleted_at is not null then
    return pg_catalog.jsonb_build_object('ok',true,'id',p_id);
  end if;
  if task.cos_version <> p_version then
    raise exception using errcode='PT409',message='task_version_conflict';
  end if;
  if exists (select 1 from public.time_entries where commitment_id=p_id and source='timer' and ended_at is null) then
    raise exception using errcode='PT423',message='task_timer_running';
  end if;

  -- No task row is physically removed. Existing calendar synchronization treats
  -- cancelled tasks as absent and removes the app-owned Google event safely.
  update public.commitments set status='cancelled',deleted_at=now() where id=p_id;
  -- Visible graph edges must not prevent moving surviving tasks to other projects.
  delete from public.commitment_links where source_commitment_id=p_id or target_commitment_id=p_id;
  delete from public.project_task_layout where commitment_id=p_id;
  return pg_catalog.jsonb_build_object('ok',true,'id',p_id);
end;
$function$;

revoke all privileges on function public.cos_delete_task(uuid,integer) from public, anon, authenticated;
grant execute on function public.cos_delete_task(uuid,integer) to service_role;

create or replace function public.cos_guard_deleted_task()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare request_role text;
begin
  if tg_op='UPDATE' and old.deleted_at is not null then
    raise exception using errcode='PT410',message='task_deleted';
  end if;
  if new.deleted_at is not null then
    request_role := coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.role',true),''),
      nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'role',
      ''
    );
    if request_role <> 'service_role' or new.status is distinct from 'cancelled' then
      raise exception using errcode='42501',message='task_delete_forbidden';
    end if;
  end if;
  return new;
end;
$function$;

-- Run before cos_track_task so a rejected stale save does not enter history.
drop trigger if exists cos_00_guard_deleted_task on public.commitments;
create trigger cos_00_guard_deleted_task before insert or update on public.commitments
for each row execute function public.cos_guard_deleted_task();
revoke all privileges on function public.cos_guard_deleted_task() from public, anon, authenticated;
grant execute on function public.cos_guard_deleted_task() to service_role;

create or replace function public.cos_guard_deleted_task_timer()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare task_deleted_at timestamptz;
begin
  -- Existing closed intervals remain editable. New entries, reassignment and
  -- restarting an interval must check the task under a lock shared with deletion.
  if tg_op='INSERT' or new.commitment_id is distinct from old.commitment_id
    or (new.source='timer' and new.ended_at is null) then
    select deleted_at into task_deleted_at from public.commitments
      where id=new.commitment_id for key share;
    if task_deleted_at is not null then
      raise exception using errcode='PT410',message='task_deleted';
    end if;
  end if;
  return new;
end;
$function$;
drop trigger if exists cos_guard_deleted_task_timer on public.time_entries;
create trigger cos_guard_deleted_task_timer before insert or update of commitment_id, source, ended_at
on public.time_entries for each row execute function public.cos_guard_deleted_task_timer();
revoke all privileges on function public.cos_guard_deleted_task_timer() from public, anon, authenticated;
grant execute on function public.cos_guard_deleted_task_timer() to service_role;

create or replace function public.cos_guard_deleted_task_link()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare task record;
begin
  -- A stale canvas must not recreate an edge after deletion removed it. Keep
  -- both parent rows locked until the graph write commits, in stable ID order.
  -- An UPDATE already owns its child row before this trigger executes. NOWAIT
  -- avoids a child -> task / task -> child deadlock with cos_delete_task.
  begin
    for task in
      select id,deleted_at from public.commitments
      where id in (new.source_commitment_id,new.target_commitment_id)
      order by id for key share nowait
    loop
      if task.deleted_at is not null then
        raise exception using errcode='PT410',message='task_deleted';
      end if;
    end loop;
  exception when lock_not_available then
    raise exception using errcode='PT409',message='task_change_in_progress';
  end;
  -- Existing project validation and foreign keys still reject missing tasks,
  -- mismatched projects and malformed graph edges.
  return new;
end;
$function$;
drop trigger if exists cos_00_guard_deleted_task_link on public.commitment_links;
create trigger cos_00_guard_deleted_task_link before insert or update
on public.commitment_links for each row execute function public.cos_guard_deleted_task_link();
revoke all privileges on function public.cos_guard_deleted_task_link() from public, anon, authenticated;
grant execute on function public.cos_guard_deleted_task_link() to service_role;

create or replace function public.cos_guard_deleted_task_layout()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare task_deleted_at timestamptz;
begin
  -- Guard position-only updates too: an old drag/upsert must never restore a
  -- deleted task's layout. NOWAIT uses the same deadlock rule as graph writes.
  begin
    select deleted_at into task_deleted_at from public.commitments
      where id=new.commitment_id for key share nowait;
  exception when lock_not_available then
    raise exception using errcode='PT409',message='task_change_in_progress';
  end;
  if task_deleted_at is not null then
    raise exception using errcode='PT410',message='task_deleted';
  end if;
  return new;
end;
$function$;
drop trigger if exists cos_00_guard_deleted_task_layout on public.project_task_layout;
create trigger cos_00_guard_deleted_task_layout before insert or update
on public.project_task_layout for each row execute function public.cos_guard_deleted_task_layout();
revoke all privileges on function public.cos_guard_deleted_task_layout() from public, anon, authenticated;
grant execute on function public.cos_guard_deleted_task_layout() to service_role;

commit;
