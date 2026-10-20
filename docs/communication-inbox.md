# Communication inbox

Telegram text and voice messages are captured as private quick notes and durable
inbox records. Gmail has a separate import/review flow described in `gmail-pilot.md`.

The source is saved before transcription or analysis. Voice originals live in
the private `cos-communication-audio` bucket. Owner-authenticated audio playback
goes through `/api/notes/inbox/:id/audio`; Telegram URLs and bot credentials never
reach the browser.

Analysis proposes tasks, updates to existing tasks, expectations (`to_me`),
project current state, decisions and questions. Existing project briefs remain
the single project-state record. Unknown people/projects and uncertain dates
remain visible for review. Relative dates use the communication's original date
and configured timezone; user corrections have their own timestamps.

New direct owner commands in Telegram can create tasks and meetings immediately
(version 3.18.0). This applies to text and voice messages captured after deployment,
not forwards, Gmail, old receipts or messages more than 24 hours old. Source
quotes, dates, clock values and identities are checked before automatic creation.
Unknown people and missing optional project/date fields do not block a task.
Ambiguous dates, past reports, negation, existing-task changes and project edits
remain for explicit review. A meeting requires an exact day and clock time.

A batch applies in one database transaction, with task versions and project-brief
revisions checked.
Stable request IDs make an uncertain-response retry replay the original result.
Conflicts roll back the entire batch. Calendar synchronization sees only the
saved task and meeting changes through the existing synchronization mechanism.

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

## Opening cards and resolving participants

Telegram links must work both on a cold load and when the browser reuses an
existing dashboard tab. Hash navigation runs the same unsaved-change guard as
in-app navigation. On mobile, the selected card is displayed before the list.

The inbox login form supplies the browser timezone and an inbox-only return
target. The OAuth state stores that target, bound to the existing browser/state
checks. Successful sign-in returns to the card without a calendar settings
dialog. Drafts remain in their original tab when reauthentication is needed.
Apply `calendar-oauth-return.sql` before deploying the calendar handler update.
For the calendar Edge Function deployment, package its six modules at the bundle
root (`index.ts`, `handler.mjs`, `store.mjs`, `google.mjs`, `sync.mjs`,
`projector.mjs`) and rewrite only the handler's projector import to
`./projector.mjs`; nested archive packaging returned a provider internal error.

An unresolved participant can be created from the proposal. Creating the person
uses the existing owner-only participants API and a stable client UUID for retry;
an existing name requires explicit selection. This does not apply the proposal.

## Direct capture (3.18.0)

- `communication-auto.mjs` checks eligibility only when the trusted Telegram
  capture metadata opts in. Shared analysis and Gmail processing never auto-apply.
- `time-evidence.mjs` accepts literal `15:00`, `15.00`, `15 часов` and `в 15`.
  Dotted clocks are excluded from calendar-date counting. Relative dates use the
  original message timestamp and configured timezone, not processing time.
- `autoApply` reuses the persisted analysis ID as the apply request ID. The
  existing receipt/revision transaction prevents duplicate creation after retries.
- The bot confirms actual saved entities, shows work time separately from a due
  date and links to their inbox receipt. The applied receipt opens editable task
  or meeting cards; meetings without a project also have an editor.
- `inbox-cancel-created.sql` adds service-only cancellation of a created task or
  meeting referenced by its receipt. Modified records require opening their card.
  Repeated cancellation cannot overwrite a later reopening. Calendar's existing
  source synchronization observes creation, edits and cancellation.
- A meeting without a stated duration uses 30 minutes, disclosed in the reply.
  An unresolved person's original name/evidence remains in task details or agenda.

Deploy the additive cancel RPC, then `cos-notes` and the dashboard, and finally
`telegram-webhook`. Include the new shared modules in every deployed bundle that
imports the communication service (`cos-google-calendar` also hosts Gmail).
Run `automatic-capture.test.cjs`, the full Node suite and the rolled-back database
smoke test `supabase/tests/inbox-cancel-created-smoke.sql`.
