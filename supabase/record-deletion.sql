-- Additive deletion markers retain source links, deduplication receipts and history.
begin;
alter table public.commitments add column if not exists deleted_at timestamptz;
alter table public.project_notes add column if not exists deleted_at timestamptz;
alter table public.quick_notes add column if not exists deleted_at timestamptz;

create or replace function public.cos_guard_deleted_note()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare request_role text;
begin
  if tg_op='UPDATE' and old.deleted_at is not null then
    raise exception using errcode='PT410',message='note_deleted';
  end if;
  if new.deleted_at is not null then
    request_role := coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.role',true),''),
      nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'role',
      ''
    );
    if request_role <> 'service_role' then
      raise exception using errcode='42501',message='note_delete_forbidden';
    end if;
    -- Existing source-to-task RPC rejects archived notes, including tombstones.
    new.archived_at := coalesce(new.archived_at,new.deleted_at);
  end if;
  return new;
end;
$function$;
revoke all privileges on function public.cos_guard_deleted_note() from public,anon,authenticated;
grant execute on function public.cos_guard_deleted_note() to service_role;
drop trigger if exists cos_00_guard_deleted_note on public.project_notes;
create trigger cos_00_guard_deleted_note before insert or update on public.project_notes
for each row execute function public.cos_guard_deleted_note();
drop trigger if exists cos_00_guard_deleted_note on public.quick_notes;
create trigger cos_00_guard_deleted_note before insert or update on public.quick_notes
for each row execute function public.cos_guard_deleted_note();
commit;
