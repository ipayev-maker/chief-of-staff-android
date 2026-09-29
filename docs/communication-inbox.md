# Communication inbox

Telegram text and voice messages are captured as private quick notes and durable
inbox records. Email is deliberately outside this release.

The source is saved before transcription or analysis. Voice originals live in
the private `cos-communication-audio` bucket. Owner-authenticated audio playback
goes through `/api/notes/inbox/:id/audio`; Telegram URLs and bot credentials never
reach the browser.

Analysis proposes tasks, updates to existing tasks, expectations (`to_me`),
project current state, decisions and questions. Existing project briefs remain
the single project-state record. Unknown people/projects and uncertain dates
remain visible for review. Relative dates use the communication's original date
and configured timezone; user corrections have their own timestamps.

Nothing changes business records until the owner confirms. A batch applies in
one database transaction, with task versions and project-brief revisions checked.
Stable request IDs make an uncertain-response retry replay the original result.
Conflicts roll back the entire batch. Calendar synchronization sees only the
confirmed task changes through the existing synchronization mechanism.

## Components

- `supabase/communication-inbox.sql`: private inbox, request receipts, processing
  leases and atomic apply RPCs.
- `supabase/functions/cos-notes/communication-inbox.mjs`: shared analysis,
  validation, review and application service.
- `supabase/functions/telegram-webhook/voice.mjs`: bounded private audio capture,
  transcription through the existing OpenRouter account and playback.
- `web/inbox.js` and `web/inbox.css`: review, editing, correction/reanalysis,
  deferral and history.
- `#/inbox/:id`: addressable communication, shared by Telegram and the dashboard.

## Release order

1. Run synthetic Node tests and the isolated database smoke test.
2. Apply the additive SQL migration and run the live smoke test with rollback.
3. Deploy `cos-notes`, including the shared inbox and voice dependencies.
4. Publish the dashboard and verify the preview with synthetic fixtures.
5. Deploy `telegram-webhook` after the dashboard is available.

Real user messages and paid transcription are not test fixtures. Preview pages
use memory-only adapters with external requests disabled and are excluded from
production builds.

## Telegram receipt regression

The shared store defaults to ordering by `id`. Telegram receipts instead use
`(chat_id, message_id)`, settings use `singleton`, and project briefs use
`project_id`. These orders are registered in the store; the webhook also states
the receipt order explicitly. Invalid `id` ordering caused HTTP 503 before
capture and then prevented timezone loading after successful transcription.
`telegram-runtime-regression.test.cjs` exercises the actual runtime, store and
processing service with strict synthetic validation of these database columns.

Voice failures persist bounded stage/status codes, never provider bodies or
credential-bearing URLs. Telegram `getFile` paths are validated as safe relative
paths without assuming a `voice/` directory. Provider and model remain unchanged.
