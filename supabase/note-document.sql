begin;
alter table public.quick_notes add column if not exists document jsonb;
alter table public.quick_notes add constraint quick_notes_document_size check(document is null or (jsonb_typeof(document)='object' and octet_length(document::text)<=300000));
commit;
