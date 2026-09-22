# Standalone notes: schema and owner access contract

Contract for the standalone-notes schema, owner API and transactional Telegram ingestion.

## Existing schema inspected without reading message contents

| Existing entity | Finding | Consequence |
| --- | --- | --- |
| `project_notes` | `project_id NOT NULL`, project FK cascades on delete; permissive anonymous CRUD policies | Keep separate from private Telegram notes. Making its project optional would expose the new text through existing anonymous REST access. |
| `note_assets` | Requires both project and project-note IDs; anonymous CRUD policies | Standalone notes do not use these assets or their access rules. |
| `messages` | Contains Telegram update/message/chat/user IDs and raw payload; no unique key on Telegram IDs; RLS enabled with no policies | A raw-message UUID alone does not deduplicate webhook deliveries. No anonymous rows are visible through the current policy set. |
| `inbox` | Contains raw text, Telegram user/message IDs; lacks chat/update IDs; RLS disabled and anonymous SELECT granted | Do not add a new notes-ingestion path that writes private note text to this table. Its existing access needs separate remediation. |
| `cos_sources` | Has unique-source-style `external_key`, channel, raw text, user/chat IDs and processing metadata | Task capture is a separate pipeline; do not turn standalone notes into task drafts. |
| Owner sessions | `cos_calendar_sessions` stores SHA-256 token hash, verified `google_sub`, expiry; service-only grants and RLS | Reuse the server-side session check narrowly. No new anonymous data access is needed. |

There is no dedicated `telegram_users`, `journal` or `rawlogs` table in `public`.
No owner IDs, private text, raw payload or credential values were read for this review.

## Table

`public.quick_notes` is a new service-only entity for the single configured owner.
It has no dependency on a project and no anonymous/authenticated grants or policies.
`project_id` is optional; deleting a project clears the link and preserves the note.

Fields: `id UUID`, `title TEXT DEFAULT ''`, `plain_text TEXT NOT NULL` (nonblank),
`project_id UUID NULL`, `source TEXT ('telegram'|'web') DEFAULT 'web'`,
`source_message_id UUID NULL` referencing `messages`, nullable Telegram chat/message/update
`BIGINT` values, `created_at`, `updated_at`, `archived_at`, `revision INTEGER DEFAULT 1`.
The update trigger increments `revision` and refreshes `updated_at`.

This is explicitly a **single-owner, single-bot** schema. Owner identity is checked
before every API request. A verified session belongs to the configured owner only
when its `google_sub` matches the `cos_calendar_connection` singleton's subject.
Do not accept an arbitrary verified Google account. Multi-owner or multi-bot support
requires explicit owner/bot columns and corresponding composite uniqueness first.

## Owner-only API

Reuse `__Host-cos-calendar-session`: Secure, HttpOnly, SameSite=Lax, Path=/.
Hash the supplied cookie token, look up a nonexpired server-side session, and compare
the subject with `cos_calendar_connection(id='owner').google_sub`. Missing connection,
missing/expired/revoked session or a different subject yields 401 without note contents.
Calendar status need not be `connected`; a valid owner session is sufficient.
The existing calendar disconnect endpoint deletes these sessions, so it also revokes
notes access. No Google access/refresh token is required to read or edit notes.

Require the exact application Origin on writes, enforce JSON and request-size limits,
and return `Cache-Control: no-store`. Do not enable wildcard credentialed CORS.
Queries go through the server's service credential, never the browser's publishable key.

HTTP PATCH accepts `title`, `plain_text`, `project_id`, boolean `archived` and the
required current `revision`. The server converts `archived` into its own timestamp
or NULL; clients cannot send `archived_at`. Source fields, IDs and timestamps are
read-only. The supplied revision is a precondition, never a new stored revision.
The server uses `id=eq.<uuid>&revision=eq.<expected>` and `return=representation`.
The DB trigger changes revision; an empty returned array is a 409 conflict rather than
a successful edit. Send the returned row/revision back to the editor. Archiving and
restoring use the same CAS rule. UI keeps unsaved text on conflict/error.

List active and archived separately and order deterministically by `created_at DESC, id DESC`.
Notes remain plain text; escape rendered content. A title may stay empty, with a display
fallback derived from the first line. Saving a blank body is rejected by both API and DB.

## Telegram ingestion and duplicate handling

Before saving a note, the Telegram webhook must verify its shared secret, configured
owner user ID, allowed private chat and update type. Fail closed when these checks are
not configured. This validation belongs in the trusted bot handler; Google browser
sessions are not a Telegram webhook credential.

Persist the Telegram chat/message IDs from the incoming **user message**. For an inline
button callback, use the original source message IDs, not the bot's reply message ID.
Store `source_message_id` when a corresponding durable `messages` row is available.
No new copy is written to anonymous `project_notes`, `inbox` or task-capture records.

Server configuration uses Vault secret `cos_notes_config` with keys
`webhookSecret`, `telegramOwnerUserId` and `telegramOwnerChatId`. IDs are decimal
strings; secret values are provisioned outside source control. Read through
`cos_notes_get_config()`, a service-only INVOKER RPC wrapping the guarded private
`cos_notes_private.get_config()` definer. Do not expose this configuration endpoint
through a browser route. Validate configuration before accepting any webhook update.

Unique indexes prevent duplicate notes by `(telegram_chat_id, telegram_message_id)`,
`telegram_update_id` when present, and `source_message_id` when present. Since edited
Telegram messages may receive another update ID, the chat/message key is essential.

Use INSERT. On SQLSTATE `23505`, fetch the matching existing row and return its ID as
already saved. **Never use merge-duplicates/upsert to overwrite note text**, including
when the existing note is archived or has been edited in the web UI. Identity conflicts
between different rows must fail rather than selecting an unrelated note. No automatic
unarchive occurs. This release has no hard-delete API, retaining deduplication history.

The companion `supabase/telegram-notes-ingest.sql` provides the committed-result ledger
`cos_notes_telegram_receipts` for the first successful processing of each chat/message.
Its PK is `(chat_id,message_id)` with a separate unique `update_id`. It stores IDs,
kind and result JSON, without duplicating the source text. The webhook checks this
service-only ledger before classification; an already committed message does not
invoke the classifier again or resend a completion notification.
The ledger records the first successful outcome, not every later edit or delivery
attempt. Media ingestion is outside this text-note schema.

The service-only INVOKER RPC `cos_notes_ingest_telegram` rechecks owner/chat against
Vault configuration and takes a transaction advisory lock for the source message.
It reserves the update receipt, then either inserts a private standalone note or calls
the existing correction/inbox/entity helpers. All changes commit together. A duplicate
returns the original result with `duplicate:true`; a changed classifier outcome cannot
create both a note and a task. The note branch never calls legacy helpers. The entity
branch preserves correction behavior and now supplies the required Telegram message
ID to `save_to_inbox`. It does not overwrite contact metadata with absent values.

RPC arguments, in order: `p_update_id BIGINT`, `p_message_id BIGINT`, `p_chat_id BIGINT`,
`p_user_id BIGINT`, `p_text TEXT`, `p_kind TEXT ('note'|'entities')`, optional
`p_project JSON`, `p_commitments JSON`, `p_events JSON`, `p_extracted JSONB`.
Result includes `kind`, nullable `note_id`/`inbox_id`, `commitment_ids` and `duplicate`;
entity results also include project/count/correction identifiers. No raw text or
configuration value is returned by the RPC.

## Validation boundary

The schema test checks the source-level privacy/uniqueness/CAS invariants. The SQL script
also executes live ACL/RLS assertions when deployed. A transactional database test after
deployment should verify duplicate INSERT rejection, preservation of edited text, CAS
revision mismatch, archive/restore revision changes, and anonymous denial. No production
message content or secret values need to be returned during those checks.
