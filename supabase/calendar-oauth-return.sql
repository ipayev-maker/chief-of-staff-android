-- Preserve an inbox card through the existing Google owner sign-in flow.
-- Additive only: existing pending states retain NULL and return to the root.
-- This private table keeps its existing forced RLS and service-only grants.
begin;

alter table public.cos_calendar_oauth_states
  add column if not exists return_to text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cos_calendar_oauth_states'::regclass
      and conname = 'cos_calendar_oauth_states_return_to_check'
  ) then
    alter table public.cos_calendar_oauth_states
      add constraint cos_calendar_oauth_states_return_to_check
      check (
        return_to is null
        or (
          char_length(return_to) in (8, 45)
          and return_to ~ '^/#/inbox(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'
        )
      );
  end if;
end;
$$;

comment on column public.cos_calendar_oauth_states.return_to is
  'Allowlisted local inbox route, bound to the one-use owner OAuth state.';

commit;
