-- Project note titles are optional in the editor; retain NOT NULL and all
-- existing rows, foreign keys, content checks, permissions and RLS policies.
begin;

alter table public.project_notes
  drop constraint if exists project_notes_title_nonempty;
alter table public.project_notes
  alter column title set default '';

do $assertions$
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid='public.project_notes'::regclass
      and attname='title' and attnotnull and not attisdropped
  ) then
    raise exception 'Project note titles must remain NOT NULL.';
  end if;
end;
$assertions$;

notify pgrst, 'reload schema';
commit;
