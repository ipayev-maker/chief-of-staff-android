# Gmail weekly task delivery — 3.19.0

Owner-approved behavior: discover/read the last seven days, poll every 15 minutes,
and deliver actionable mail to Tasks. Gmail remains read-only. Source dates govern
deadlines; delivery time never changes their meaning.

The old permanent 50-thread pilot cap dropped new thread IDs while advancing
history. Pending manual reviews also blocked later replies. Discovery now persists
all scoped IDs before advancing history, and automatic delivery acknowledges each
source atomically. Reading proceeds through bounded chronological batches with
processed-message IDs, including long threads and replies to applied sources.

Clear, grounded task creations apply automatically. Uncertain dates, proposed
changes, project changes, meetings, existing-task updates and failed analysis create
one undated "Разобрать письмо" task with its source. Informational sources are
acknowledged without business mutations. This policy does not complete, cancel or
reschedule existing tasks automatically. AI consent and automatic task delivery
remain separate settings. Automatic sources are hidden from the Inbox list but
remain accessible from task source links.

## Deployment

Apply `supabase/gmail-week-tasks.sql` and `supabase/auth-domain-bridge.sql`, deploy
all three functions importing the shared communication code, and apply
`supabase/gmail-schedule.sql`. Enable `auto_tasks`, `initial_days:7`, `context_days:7`
for the authorized mailbox and reset discovery. Preserve processed IDs from applied
sources when retiring old pilot snapshots; never mark unapplied messages processed.
Soft-delete old imported notes only, retaining existing tasks and original Gmail.

## Nikodim

Public address: https://nikodim.vercel.app . Keep the original production address
and registered Google callback available. POST login on Nikodim sets a secure,
HTTP-only verifier cookie, then starts Google OAuth on the registered domain.
After normal identity validation, the callback issues an encrypted, two-minute,
one-use transfer tied to the initiating browser. The new domain atomically consumes
it, verifies the cookie, and sets its own session. Session tokens never enter URLs.
Both explicit origins are accepted for authenticated writes; arbitrary origins are
rejected. Existing Google Calendar and Gmail refresh tokens are unchanged.

Validation includes the 51st thread, week boundary, long-thread batching, immediate
task creation, repeated delivery, uncertain-mail fallback, information-only mail,
consent, and complete login transfer including wrong-browser and replay rejection.

### 3.19.1 — Mail awaiting a decision

The Tasks screen places generated “Разобрать письмо:” tasks in a separate
“Неразобранные” section above area/project filters. It recognizes the existing
fallback title together with the generated, allowlisted inbox-source link; no
mail is copied or imported again. Newest imports appear first. Search applies
to both pending and ignored mail; area filters apply only to ordinary tasks.

“Ignore” persists the existing task's `cancelled` status with a conditional
`cos_version`/status PATCH and requires the returned matching row. It does not
mark work completed, delete Gmail mail, reset processed message IDs, or mute
future replies. “Игнорированные” is collapsed by default and allows restoring
the same task to `open`. Existing completion still resolves a review task;
renaming it into a concrete action moves it into the normal task list. No new
schema or backend deployment is required.

Regression coverage: legacy recognition, order/filter placement, no duplicate
rows, escaping, source deep link, persisted ignore/restore, stale-version and
network errors, duplicate clicks, and active-timer protection.


### 3.20.0 — Mixed automatic delivery

Each grounded action is assessed independently. Direct requests to the owner,
owner promises and promises from others become tasks/expectations when the
new-message evidence, responsibility and direct recipient/sender agree. Missing
optional project/person/date does not block creation. Quoted history, CC-only
responsibility, updates and meetings require explicit review. Proposed dates are
kept as suggestions and do not silently become deadlines.

`cos_gmail_deliver_hybrid` applies new tasks and creates one review item per
uncertain action atomically. Review children share the original immutable note;
a partial unique index preserves one primary capture per note. Existing owner
session/CSRF checks and service-only RPCs remain in force. Each suggestion uses
the existing revisioned apply/defer flow, with restore support. Technical errors
receive three attempts spaced by at least 15 minutes, with at most two serial
analyses per tick. Exhausted failures remain technical review items, never fake
business tasks. Safe provider HTTP status is retained, not response bodies.

The one-time `hybrid_backfill` setting queues only untouched open legacy fallback
tasks. Original apply receipts and processed Gmail IDs remain intact. Replacement
rechecks task version and active timers under a transaction lock. Edited,
completed, ignored or deleted tasks are preserved. No Gmail message is modified.
