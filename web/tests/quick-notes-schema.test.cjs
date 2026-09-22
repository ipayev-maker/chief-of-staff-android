const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../../supabase/quick-notes-schema.sql'), 'utf8');

test('standalone notes do not require a project and preserve notes when source/project is deleted', () => {
  assert.match(sql, /create table if not exists public\.quick_notes/);
  assert.match(sql, /project_id uuid references public\.projects\(id\) on delete set null/);
  assert.match(sql, /source_message_id uuid references public\.messages\(id\) on delete set null/);
  assert.doesNotMatch(sql, /project_id uuid not null|on delete cascade/i);
  assert.match(sql, /plain_text text not null/);
  assert.ok(sql.includes("quick_notes_text_nonempty check (plain_text ~ '[^[:space:]]')"));
});

test('Telegram deduplication covers chat/message, update and durable raw-message identities', () => {
  assert.match(sql, /create unique index if not exists quick_notes_telegram_message_unique\s+on public\.quick_notes \(telegram_chat_id, telegram_message_id\) where source = 'telegram'/);
  assert.match(sql, /create unique index if not exists quick_notes_telegram_update_unique\s+on public\.quick_notes \(telegram_update_id\)/);
  assert.match(sql, /create unique index if not exists quick_notes_source_message_unique\s+on public\.quick_notes \(source_message_id\)/);
  assert.match(sql, /source = 'telegram' and telegram_chat_id is not null and telegram_message_id is not null/);
  assert.doesNotMatch(sql, /on conflict[\s\S]*do update/i);
});

test('privacy is service-only, with forced RLS and deployment privilege assertions', () => {
  assert.match(sql, /alter table public\.quick_notes enable row level security;/);
  assert.match(sql, /alter table public\.quick_notes force row level security;/);
  assert.match(sql, /revoke all privileges on table public\.quick_notes from public, anon, authenticated;/);
  assert.match(sql, /grant select, insert, update, delete on table public\.quick_notes to service_role;/);
  assert.match(sql, /has_any_column_privilege/);
  assert.doesNotMatch(sql, /create policy|grant[^;]*to\s+(anon|authenticated|public)\b/i);
  assert.doesNotMatch(sql, /alter table public\.(project_notes|inbox|messages)\b/i);
});

test('updates use server-controlled monotone revisions for CAS editing and archiving', () => {
  assert.match(sql, /revision integer not null default 1/);
  assert.match(sql, /new\.revision := old\.revision \+ 1;/);
  assert.match(sql, /new\.updated_at := pg_catalog\.clock_timestamp\(\);/);
  assert.match(sql, /before update on public\.quick_notes/);
  assert.match(sql, /security invoker\s+set search_path = ''/);
  assert.match(sql, /archived_at timestamptz/);
  assert.match(sql, /revoke all privileges on function public\.cos_quick_notes_version\(\) from public, anon, authenticated;/);
});

test('configuration getter has a service-only private definer and public invoker wrapper', () => {
  assert.match(sql, /revoke all privileges on schema cos_notes_private from public, anon, authenticated;/);
  const getter = sql.split('create or replace function cos_notes_private.get_config()')[1].split('$function$;')[0];
  assert.match(getter, /security definer\s+set search_path = ''/i);
  assert.match(getter, /request_role <> 'service_role'/);
  assert.match(getter, /where name='cos_notes_config'/);
  const wrapper = sql.split('create or replace function public.cos_notes_get_config()')[1].split('$function$;')[0];
  assert.match(wrapper, /security invoker\s+set search_path = ''/i);
  assert.match(wrapper, /select cos_notes_private\.get_config\(\)/);
  for (const name of ['cos_notes_private.get_config', 'public.cos_notes_get_config']) {
    assert.ok(sql.includes(`revoke all privileges on function ${name}() from public, anon, authenticated;`));
    assert.ok(sql.includes(`grant execute on function ${name}() to service_role;`));
  }
  assert.doesNotMatch(sql, /grant[^;]*vault\.decrypted_secrets/i);
});
