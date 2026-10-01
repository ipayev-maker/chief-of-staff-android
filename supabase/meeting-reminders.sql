-- NULL means no reminder; 0 means at the start. Keep the existing 15-minute default
-- and 0..1440 check. Existing rows, permissions, policies and authentication stay intact.
alter table public.meetings alter column remind_before_minutes drop not null;
comment on column public.meetings.remind_before_minutes is
  'Minutes before meeting start for app and Google popup reminders; NULL disables, 0 means at start, default 15.';
