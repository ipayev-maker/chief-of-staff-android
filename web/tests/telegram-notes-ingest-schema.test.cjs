const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname,'../../supabase/telegram-notes-ingest.sql'),'utf8');

test('receipt ledger deduplicates both message identity and bot update before side effects', () => {
  assert.match(sql,/primary key \(chat_id,message_id\)/);
  assert.match(sql,/update_id bigint not null unique/);
  assert.match(sql,/pg_catalog\.pg_advisory_xact_lock/);
  const reserve = sql.indexOf('insert into public.cos_notes_telegram_receipts(chat_id');
  assert.ok(reserve < sql.indexOf('insert into public.quick_notes('));
  assert.ok(reserve < sql.indexOf('public.consume_correction(p_telegram_user_id'));
  assert.ok(sql.indexOf("return receipt.result_json || pg_catalog.jsonb_build_object('duplicate',true)") < reserve);
});

test('ingest rechecks configured owner with NULL-safe fail-closed comparisons', () => {
  assert.match(sql,/cfg := public\.cos_notes_get_config\(\)/);
  assert.match(sql,/\(cfg->>'telegramOwnerUserId'\) is distinct from p_user_id::text/);
  assert.match(sql,/\(cfg->>'telegramOwnerChatId'\) is distinct from p_chat_id::text/);
  assert.match(sql,/p_kind not in \('note','entities'\)/);
  assert.match(sql,/security invoker/);
});

test('note branch preserves existing note text and does not create legacy/raw task records', () => {
  const branch = sql.split("if p_kind='note' then")[1].split('\n  else\n')[0];
  assert.match(branch,/on conflict do nothing/);
  assert.doesNotMatch(branch,/do update|update public\.quick_notes|public\.save_to_inbox|public\.save_all_entities|public\.consume_correction|public\.upsert_contact/);
  assert.match(branch,/source='telegram' and telegram_chat_id=p_chat_id and telegram_message_id=p_message_id/);
});

test('legacy adoption rejects an update attached to another note before adopting a chat/message match', () => {
  const adoption = sql.split('if not found then')[1].split('\n      already_saved := true;')[0];
  assert.match(adoption,/source='telegram' and telegram_update_id=p_update_id/);
  assert.match(adoption,/telegram_chat_id is distinct from p_chat_id or telegram_message_id is distinct from p_message_id/);
  const reject = adoption.indexOf("message='Telegram update identity conflicts with another note.'");
  const matchingNote = adoption.indexOf('select * into note_row from public.quick_notes');
  assert.ok(reject >= 0 && matchingNote > reject, 'Crossed update identity must fail before legacy note A can be adopted');
});

test('entities transaction preserves correction and requires message ID for legacy inbox creation', () => {
  assert.match(sql,/public\.save_to_inbox\(\s+p_telegram_message_id => p_message_id,/);
  assert.match(sql,/public\.consume_correction\(p_telegram_user_id => p_user_id\)/);
  assert.match(sql,/public\.save_all_entities\(/);
  assert.match(sql,/\(entity_result->>'success'\) is distinct from 'true'/);
  assert.doesNotMatch(sql,/public\.upsert_contact\(/);
  assert.match(sql,/set search_path = pg_catalog, public, pg_temp/);
});

test('receipt data and ingest RPC remain service-only with RLS and ACL assertions', () => {
  assert.match(sql,/alter table public\.cos_notes_telegram_receipts enable row level security/);
  assert.match(sql,/alter table public\.cos_notes_telegram_receipts force row level security/);
  assert.match(sql,/revoke all privileges on table public\.cos_notes_telegram_receipts from public, anon, authenticated/);
  assert.match(sql,/revoke all privileges on function public\.cos_notes_ingest_telegram\([^;]*from public, anon, authenticated/);
  assert.match(sql,/has_any_column_privilege/);
  assert.doesNotMatch(sql,/security definer|create policy|grant[^;]*to\s+(anon|authenticated|public)\b/i);
});
