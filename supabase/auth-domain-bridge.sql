begin;
alter table public.cos_calendar_oauth_states add column if not exists return_challenge text check(return_challenge is null or return_challenge~'^[a-f0-9]{64}$');
alter table public.cos_gmail_oauth_states add column if not exists return_challenge text check(return_challenge is null or return_challenge~'^[a-f0-9]{64}$');
create table if not exists public.cos_auth_transfers (
  code_hash text primary key check(code_hash~'^[a-f0-9]{64}$'),
  browser_hash text not null check(browser_hash~'^[a-f0-9]{64}$'),
  session_cipher text not null,
  service text not null check(service in('gmail','calendar')),
  return_to text,
  expires_at timestamptz not null
);
create index if not exists cos_auth_transfers_expiry on public.cos_auth_transfers(expires_at);
alter table public.cos_auth_transfers enable row level security;
revoke all on public.cos_auth_transfers from public,anon,authenticated;
grant select,insert,delete on public.cos_auth_transfers to service_role;
commit;
