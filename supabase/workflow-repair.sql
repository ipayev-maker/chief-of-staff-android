begin;
alter table public.participants add column if not exists archived_at timestamptz;
create index if not exists participants_active_name_idx on public.participants(name,id) where archived_at is null;
-- The editor supports image-only notes; files remain private until confirmed.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.quick_notes'::regclass and contype='c' and pg_get_constraintdef(oid) like '%plain_text ~%' loop
  execute format('alter table public.quick_notes drop constraint %I',c.conname);
 end loop;
end $$;
create table if not exists public.cos_note_assets(
 id uuid primary key default gen_random_uuid(),note_id uuid not null references public.quick_notes(id),
 storage_bucket text not null check(storage_bucket in ('cos-note-media','project-media')),storage_path text not null,
 original_name text not null,mime_type text not null,size_bytes bigint not null check(size_bytes between 1 and 52428800),
 caption text,pending boolean not null default true,created_at timestamptz not null default now(),deleted_at timestamptz,
 unique(storage_bucket,storage_path)
);
alter table public.cos_note_assets enable row level security;
revoke all on public.cos_note_assets from anon,authenticated;
grant all on public.cos_note_assets to service_role;
create index if not exists cos_note_assets_note_idx on public.cos_note_assets(note_id,created_at) where deleted_at is null;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('cos-note-media','cos-note-media',false,52428800,array['image/jpeg','image/png','image/webp','image/gif','application/pdf','audio/mpeg','audio/mp4','audio/wav','audio/ogg','video/mp4','video/webm','video/quicktime']) on conflict(id) do nothing;
-- Keep legacy rows intact for history and task source links, using the same IDs.
insert into public.quick_notes(id,title,plain_text,project_id,source,created_at,updated_at,archived_at)
 select id,left(title,300),plain_text,project_id,'web',created_at,updated_at,archived_at from public.project_notes where deleted_at is null
 on conflict(id) do nothing;
insert into public.cos_note_assets(id,note_id,storage_bucket,storage_path,original_name,mime_type,size_bytes,caption,pending,created_at)
 select a.id,a.note_id,a.storage_bucket,a.storage_path,coalesce(a.original_name,'Файл'),coalesce(a.mime_type,'application/octet-stream'),a.size_bytes,a.caption,false,a.created_at
 from public.note_assets a join public.quick_notes n on n.id=a.note_id where a.size_bytes between 1 and 52428800
 on conflict do nothing;
create or replace function public.cos_note_media_complete(p_note uuid,p_asset uuid) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,storage,pg_temp as $$
declare a public.cos_note_assets%rowtype; m jsonb;
begin
 perform public.cos_inbox_require_service();
 select * into a from public.cos_note_assets where id=p_asset and note_id=p_note and deleted_at is null for update;
 if not found then raise exception using errcode='PT404',message='media_not_found';end if;
 if not a.pending then return jsonb_build_object('ok',true);end if;
 select metadata into m from storage.objects where bucket_id=a.storage_bucket and name=a.storage_path;
 if m is null or (m->>'size')::bigint is distinct from a.size_bytes or m->>'mimetype' is distinct from a.mime_type then raise exception using errcode='PT400',message='media_upload_incomplete';end if;
 update public.cos_note_assets set pending=false where id=p_asset;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.cos_note_media_complete(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cos_note_media_complete(uuid,uuid) to service_role;
commit;
