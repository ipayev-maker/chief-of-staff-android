-- Rollback-only schema check: no test meeting becomes visible to the sync worker.
begin;
do $test$
declare meeting_id uuid; saved_minutes integer;
begin
  insert into public.meetings(title,starts_at,ends_at)
  values ('Synthetic reminder schema check',now()+interval '7 days',now()+interval '7 days 1 hour')
  returning id,remind_before_minutes into meeting_id,saved_minutes;
  if saved_minutes is distinct from 15 then raise exception 'Default must be 15'; end if;
  update public.meetings set remind_before_minutes=null where id=meeting_id returning remind_before_minutes into saved_minutes;
  if saved_minutes is not null then raise exception 'Disabled reminder did not persist'; end if;
  update public.meetings set remind_before_minutes=0 where id=meeting_id returning remind_before_minutes into saved_minutes;
  if saved_minutes is distinct from 0 then raise exception 'At-start reminder did not persist'; end if;
  begin
    update public.meetings set remind_before_minutes=-1 where id=meeting_id;
    raise exception 'Negative reminder accepted';
  exception when check_violation then null;
  end;
  begin
    update public.meetings set remind_before_minutes=1441 where id=meeting_id;
    raise exception 'Out-of-range reminder accepted';
  exception when check_violation then null;
  end;
end $test$;
rollback;
