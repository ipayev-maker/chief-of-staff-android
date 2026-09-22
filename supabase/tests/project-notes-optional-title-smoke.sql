-- Run after project-notes-optional-title.sql through a database-owner session.
-- Uses the same anon role and blank-title payload as the browser. Every row
-- created here is rolled back. No user IDs, existing note contents or hashes
-- are returned; old-row digests are compared only inside the transaction.
begin;
set local role anon;

do $smoke$
declare
  project uuid;
  created public.project_notes%rowtype;
  defaulted public.project_notes%rowtype;
  reread public.project_notes%rowtype;
  before_rows jsonb;
  after_rows jsonb;
  updated integer;
  stage text := 'schema precondition';
  failure_code text;
begin
  if exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.project_notes'::regclass and conname='project_notes_title_nonempty') then
    raise exception 'The nonempty-title constraint is still present.';
  end if;
  if not exists(select 1 from pg_catalog.pg_attribute
    where attrelid='public.project_notes'::regclass and attname='title' and attnotnull) then
    raise exception 'The title NOT NULL requirement was lost.';
  end if;

  stage := 'select existing project metadata';
  -- Prefer the reported project; use a deterministic existing project if the
  -- display name changes. No project is created or modified by this probe.
  select id into project from public.projects
    order by (lower(btrim(title))='дашборд') desc,id asc limit 1;
  if project is null then raise exception 'An existing project is required.'; end if;

  stage := 'snapshot existing notes without returning content';
  select coalesce(jsonb_object_agg(n.id::text,md5(to_jsonb(n)::text)),'{}'::jsonb)
    into before_rows from public.project_notes n;

  stage := 'insert exact browser payload as anon';
  insert into public.project_notes(project_id,title,plain_text,content_json)
    values(project,'','','{"type":"doc","content":[]}'::jsonb)
    returning * into created;
  if created.id is null or created.title<>'' or created.plain_text<>'' then
    raise exception 'The blank-title browser payload was not saved.';
  end if;

  stage := 'default title when omitted';
  insert into public.project_notes(project_id,plain_text,content_json)
    values(project,'','{"type":"doc","content":[]}'::jsonb)
    returning * into defaulted;
  if defaulted.title is distinct from '' then
    raise exception 'An omitted title did not use the empty default.';
  end if;

  stage := 'PATCH body without title';
  update public.project_notes
    set plain_text='Synthetic project-note optional-title smoke'
    where id=created.id;
  get diagnostics updated=row_count;
  if updated<>1 then raise exception 'Body update was not confirmed.'; end if;

  stage := 'reload saved row';
  select * into reread from public.project_notes where id=created.id;
  if reread.title is distinct from ''
    or reread.plain_text is distinct from 'Synthetic project-note optional-title smoke'
    or reread.project_id is distinct from project then
    raise exception 'Reload did not preserve the empty title and edited body.';
  end if;

  stage := 'archive saved row';
  update public.project_notes set archived_at=clock_timestamp(),pinned=false
    where id=created.id;
  select * into reread from public.project_notes where id=created.id;
  if reread.archived_at is null or reread.title is distinct from '' then
    raise exception 'Archiving the untitled note failed.';
  end if;

  stage := 'verify existing rows untouched';
  select coalesce(jsonb_object_agg(n.id::text,md5(to_jsonb(n)::text)),'{}'::jsonb)
    into after_rows from public.project_notes n
    -- Only rows present in our initial snapshot belong to this assertion.
    -- A concurrent browser probe may legitimately insert a separate note.
    where before_rows ? n.id::text;
  if after_rows is distinct from before_rows then
    raise exception 'The existing-note baseline changed during this probe.';
  end if;
exception when others then
  failure_code:=sqlstate;
  -- Do not expose an error detail that might contain a database row.
  raise exception using errcode='P0001',
    message='Project-note smoke failed at '||stage||' (SQLSTATE '||failure_code||').';
end;
$smoke$;

rollback;
select 'PASS: anon empty-title create, default, body PATCH, reload and archive; existing rows unchanged; all probe rows rolled back' as result;
