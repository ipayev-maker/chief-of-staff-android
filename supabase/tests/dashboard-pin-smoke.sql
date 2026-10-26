begin;
-- Isolated synthetic identities: never mint a real owner session.
create temporary table cos_calendar_connection(id text primary key,google_sub text,email text);
create temporary table cos_gmail_connection(id text primary key,google_sub text,email text);
create temporary table cos_calendar_sessions(token_hash text primary key,google_sub text,expires_at timestamptz);
create temporary table cos_dashboard_security(like public.cos_dashboard_security including all);
create temporary table cos_dashboard_pin_sessions(like public.cos_dashboard_pin_sessions including all);
alter table pg_temp.cos_dashboard_pin_sessions add foreign key(session_hash) references pg_temp.cos_calendar_sessions(token_hash) on delete cascade;
do $$ begin
 execute replace(pg_get_functiondef('public.cos_dashboard_pin_status(text,text)'::regprocedure),'public.','pg_temp.');
 execute replace(pg_get_functiondef('public.cos_dashboard_pin_unlock(text,text,text,boolean)'::regprocedure),'public.','pg_temp.');
end $$;
insert into pg_temp.cos_calendar_connection values('owner','synthetic-pin-test','test@example.invalid');
insert into pg_temp.cos_calendar_sessions values(repeat('1',64),'synthetic-pin-test',now()+interval '1 day'),(repeat('2',64),'synthetic-pin-test',now()+interval '1 day');
insert into pg_temp.cos_dashboard_security(id) values('owner');
do $$
declare r jsonb; i integer;
begin
 r:=pg_temp.cos_dashboard_pin_status('missing',null);assert r->>'authenticated'='false','anonymous status';
 r:=pg_temp.cos_dashboard_pin_status(repeat('1',64),null);assert r->>'setupRequired'='true' and r->>'unlocked'='false','initial enrollment gate';
 r:=pg_temp.cos_dashboard_pin_unlock(repeat('1',64),repeat('a',64),repeat('b',64),false);assert r->>'error'='pin_setup_required','cannot unlock before setup';
 r:=pg_temp.cos_dashboard_pin_unlock(repeat('1',64),repeat('a',64),repeat('b',64),true);assert r->>'ok'='true','enrollment';
 assert (select pin_hash like '$2a$12$%' and pin_hash<>repeat('a',64) from pg_temp.cos_dashboard_security),'salted bcrypt cost 12';
 r:=pg_temp.cos_dashboard_pin_status(repeat('1',64),repeat('b',64));assert r->>'unlocked'='true','bound proof works';
 r:=pg_temp.cos_dashboard_pin_status(repeat('2',64),repeat('b',64));assert r->>'unlocked'='false','proof cannot cross sessions';
 r:=pg_temp.cos_dashboard_pin_unlock(repeat('2',64),repeat('c',64),repeat('d',64),true);assert r->>'error'='pin_already_configured','setup cannot overwrite';
 for i in 1..4 loop
  r:=pg_temp.cos_dashboard_pin_unlock(repeat('1',64),repeat('c',64),repeat('d',64),false);assert r->>'error'='pin_incorrect','wrong PIN';
 end loop;
 r:=pg_temp.cos_dashboard_pin_unlock(repeat('1',64),repeat('c',64),repeat('d',64),false);assert r->>'error'='pin_locked' and (r->>'retryAfter')::integer=900,'fifth failure persists lock';
 r:=pg_temp.cos_dashboard_pin_unlock(repeat('2',64),repeat('a',64),repeat('d',64),false);assert r->>'error'='pin_locked','new Google session cannot evade lock';
 update pg_temp.cos_dashboard_security set locked_until=now()-interval '1 second';
 r:=pg_temp.cos_dashboard_pin_unlock(repeat('1',64),repeat('a',64),repeat('d',64),false);assert r->>'ok'='true','unlock after lockout';
 assert (select failed_attempts=0 and locked_until is null from pg_temp.cos_dashboard_security),'successful unlock resets failures';
 r:=pg_temp.cos_dashboard_pin_status(repeat('1',64),repeat('b',64));assert r->>'unlocked'='false','old proof is rotated';
 update pg_temp.cos_dashboard_pin_sessions set expires_at=now()-interval '1 second';
 r:=pg_temp.cos_dashboard_pin_status(repeat('1',64),repeat('d',64));assert r->>'unlocked'='false','expired proof rejected';
 delete from pg_temp.cos_calendar_sessions where token_hash=repeat('1',64);
 assert not exists(select 1 from pg_temp.cos_dashboard_pin_sessions),'logout cascades unlock revocation';
 assert not has_table_privilege('anon','public.cos_dashboard_security','SELECT'),'PIN table inaccessible to public';
 assert not has_table_privilege('authenticated','public.cos_dashboard_pin_sessions','INSERT'),'cannot forge unlock';
 assert not has_function_privilege('anon','public.cos_dashboard_pin_unlock(text,text,text,boolean)','EXECUTE'),'unlock RPC private';
 assert has_function_privilege('service_role','public.cos_dashboard_pin_unlock(text,text,text,boolean)','EXECUTE'),'server RPC permitted';
 assert has_function_privilege('service_role','extensions.crypt(text,text)','EXECUTE'),'hash available to server';
end $$;
rollback;
select 'PIN enrollment, salted hash, session binding, rotation, lockout, expiry, revocation and grants passed; no live rows changed' as result;
