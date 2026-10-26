-- Run after the owner_security migration, then ROLLBACK. No live records change.
begin;
do $test$
begin
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity) then raise exception 'Public table without RLS';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m') and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))) then raise exception 'Public data grant remains';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))) then raise exception 'Public RPC grant remains';end if;
 if has_schema_privilege('anon','public','USAGE') or has_schema_privilege('authenticated','public','USAGE') then raise exception 'Public schema access remains';end if;
 if exists(select 1 from storage.buckets where public) then raise exception 'Public bucket remains';end if;
end;
$test$;
set local role anon;
do $test$
begin
 begin perform 1 from public.projects limit 0;raise exception 'Anonymous read succeeded';exception when insufficient_privilege then null;end;
 begin perform public.cos_snapshot();raise exception 'Anonymous RPC succeeded';exception when insufficient_privilege then null;end;
 if exists(select 1 from storage.objects limit 1) then raise exception 'Anonymous storage read succeeded';end if;
end;
$test$;
reset role;
set local role service_role;
select id from public.projects limit 0;
select id from public.commitments limit 0;
select id from public.cos_calendar_connection limit 0;
reset role;
select 'owner_security_smoke_passed' as result;
rollback;
