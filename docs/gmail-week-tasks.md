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
