-- Additive private project context. Apply once through a reviewed migration.
-- Existing projects/tasks/notes and their policies are unchanged.
begin;

create or replace function public.cos_valid_project_brief(p_document jsonb)
returns boolean language plpgsql immutable security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  entry jsonb;
  key_name text;
  limit_value integer;
  day_text text;
  ids uuid[] := '{}'::uuid[];
  entry_id uuid;
  trim_chars text := chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
    chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' then return false; end if;
  if octet_length(p_document::text) > 98304 or
     not (p_document ?& array['goal','current_state','next_step','checkpoint_label','checkpoint_on','entries']) or
     (select count(*) from jsonb_object_keys(p_document)) <> 6 then return false; end if;
  for key_name, limit_value in select * from (values ('goal',2000),('current_state',4000),('next_step',2000),('checkpoint_label',500)) v(k,n) loop
    if jsonb_typeof(p_document->key_name) <> 'string' or char_length(p_document->>key_name) > limit_value then return false; end if;
  end loop;
  if p_document->'checkpoint_on' <> 'null'::jsonb then
    if jsonb_typeof(p_document->'checkpoint_on') <> 'string' then return false; end if;
    day_text := p_document->>'checkpoint_on';
    if day_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(day_text,4) = '0000' or
       to_char(day_text::date,'YYYY-MM-DD') <> day_text then return false; end if;
  end if;
  if jsonb_typeof(p_document->'entries') <> 'array' then return false; end if;
  if jsonb_array_length(p_document->'entries') > 60 then return false; end if;
  for entry in select value from jsonb_array_elements(p_document->'entries') loop
    if jsonb_typeof(entry) <> 'object' then return false; end if;
    if not (entry ?& array['id','kind','text','person','review_on','source','status']) or
       (select count(*) from jsonb_object_keys(entry)) <> 7 then return false; end if;
    if jsonb_typeof(entry->'id') <> 'string' or (entry->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    entry_id := (entry->>'id')::uuid;
    if entry_id = any(ids) then return false; end if;
    ids := array_append(ids,entry_id);
    if jsonb_typeof(entry->'kind') <> 'string' or (entry->>'kind') not in ('waiting','question','decision') or
       jsonb_typeof(entry->'status') <> 'string' or (entry->>'status') not in ('open','resolved') then return false; end if;
    for key_name, limit_value in select * from (values ('text',2000),('person',300),('source',1000)) v(k,n) loop
      if jsonb_typeof(entry->key_name) <> 'string' or char_length(entry->>key_name) > limit_value then return false; end if;
    end loop;
    if char_length(entry->>'text') < 1 or (entry->>'text') <> btrim(entry->>'text',trim_chars) then return false; end if;
    if entry->'review_on' <> 'null'::jsonb then
      if jsonb_typeof(entry->'review_on') <> 'string' or entry->>'kind' = 'decision' then return false; end if;
      day_text := entry->>'review_on';
      if day_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(day_text,4) = '0000' or
         to_char(day_text::date,'YYYY-MM-DD') <> day_text then return false; end if;
    end if;
  end loop;
  return true;
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then return false;
end;
$function$;

create table if not exists public.cos_project_briefs (
  project_id uuid primary key references public.projects(id),
  revision integer not null check (revision >= 1),
  document jsonb not null check (public.cos_valid_project_brief(document)),
  updated_at timestamptz not null default now()
);
create table if not exists public.cos_project_brief_history (
  project_id uuid not null references public.cos_project_briefs(project_id),
  revision integer not null check (revision >= 1),
  request_id uuid not null,
  base_revision integer not null check (base_revision >= 0 and base_revision = revision - 1),
  document jsonb not null check (public.cos_valid_project_brief(document)),
  changed_fields text[] not null check (changed_fields <@ array['goal','current_state','next_step','checkpoint_label','checkpoint_on','entries']),
  created_at timestamptz not null default now(),
  primary key (project_id, revision),
  unique (project_id, request_id)
);
alter table public.cos_project_briefs enable row level security;
alter table public.cos_project_brief_history enable row level security;
revoke all on public.cos_project_briefs, public.cos_project_brief_history from public, anon, authenticated, service_role;
grant select, insert, update on public.cos_project_briefs to service_role;
grant select, insert on public.cos_project_brief_history to service_role;

-- STABLE uses one statement snapshot for both current state and its history.
create or replace function public.cos_get_project_brief(p_project_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  brief public.cos_project_briefs%rowtype;
  changes jsonb;
  request_role text := coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
begin
  if request_role <> 'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
  if p_project_id is null then raise exception using errcode='PT400',message='invalid_project'; end if;
  if not exists(select 1 from public.projects where id=p_project_id) then
    raise exception using errcode='PT404',message='project_not_found';
  end if;
  select * into brief from public.cos_project_briefs where project_id=p_project_id;
  if not found then
    return jsonb_build_object('project_id',p_project_id,'revision',0,'updated_at',null,
      'document',jsonb_build_object('goal','','current_state','','next_step','','checkpoint_label','','checkpoint_on',null,'entries','[]'::jsonb),
      'history','[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('revision',h.revision,'created_at',h.created_at,'changed_fields',h.changed_fields) order by h.revision desc),'[]'::jsonb)
    into changes from (select revision,created_at,changed_fields from public.cos_project_brief_history
      where project_id=p_project_id and revision<=brief.revision order by revision desc limit 20) h;
  return jsonb_build_object('project_id',p_project_id,'revision',brief.revision,'updated_at',brief.updated_at,
    'document',brief.document,'history',changes);
end;
$function$;

create or replace function public.cos_save_project_brief(p_project_id uuid,p_revision integer,p_request_id uuid,p_document jsonb)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  brief public.cos_project_briefs%rowtype;
  previous public.cos_project_brief_history%rowtype;
  old_document jsonb;
  new_revision integer;
  fields text[];
  stamp timestamptz := clock_timestamp();
  request_role text := coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
begin
  if request_role <> 'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
  if p_project_id is null or p_revision is null or p_revision<0 or p_revision>=2147483647 or
     p_request_id is null or not public.cos_valid_project_brief(p_document) then
    raise exception using errcode='PT400',message='invalid_project_brief';
  end if;
  -- Existing parent row serializes concurrent first saves without modifying projects.
  perform 1 from public.projects where id=p_project_id for update;
  if not found then raise exception using errcode='PT404',message='project_not_found'; end if;
  select * into previous from public.cos_project_brief_history where project_id=p_project_id and request_id=p_request_id;
  if found then
    if previous.base_revision<>p_revision or previous.document<>p_document then
      raise exception using errcode='PT409',message='project_brief_request_conflict';
    end if;
    -- Replay acknowledges the old write but returns the latest state; no rollback.
    return public.cos_get_project_brief(p_project_id) || jsonb_build_object('replayed',true);
  end if;
  select * into brief from public.cos_project_briefs where project_id=p_project_id for update;
  if coalesce(brief.revision,0)<>p_revision then
    raise exception using errcode='PT409',message='project_brief_revision_conflict';
  end if;
  old_document := coalesce(brief.document,jsonb_build_object('goal','','current_state','','next_step','','checkpoint_label','','checkpoint_on',null,'entries','[]'::jsonb));
  select coalesce(array_agg(key_name order by ord),'{}'::text[]) into fields
    from unnest(array['goal','current_state','next_step','checkpoint_label','checkpoint_on','entries']) with ordinality x(key_name,ord)
    where old_document->key_name is distinct from p_document->key_name;
  new_revision := p_revision+1;
  insert into public.cos_project_briefs(project_id,revision,document,updated_at)
    values(p_project_id,new_revision,p_document,stamp)
    on conflict (project_id) do update set revision=excluded.revision,document=excluded.document,updated_at=excluded.updated_at;
  insert into public.cos_project_brief_history(project_id,revision,request_id,base_revision,document,changed_fields,created_at)
    values(p_project_id,new_revision,p_request_id,p_revision,p_document,fields,stamp);
  return public.cos_get_project_brief(p_project_id) || jsonb_build_object('replayed',false);
end;
$function$;

revoke all on function public.cos_valid_project_brief(jsonb),public.cos_get_project_brief(uuid),public.cos_save_project_brief(uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cos_valid_project_brief(jsonb),public.cos_get_project_brief(uuid),public.cos_save_project_brief(uuid,integer,uuid,jsonb) to service_role;
comment on table public.cos_project_briefs is 'Owner-only project context; no inferred facts. Server service role through authenticated notes API.';
comment on table public.cos_project_brief_history is 'Private revision snapshots and scoped request replay receipts. Browser sees changed field names only.';
commit;
