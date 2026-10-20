# Gmail pilot · 3.17.3

Gmail feeds the existing private communication inbox. It never sends, moves,
deletes or marks email as read. Import does not change tasks; applying a review
uses the existing version-checked, idempotent application transaction.

## Connect

1. Enable Gmail API in the existing Chief of Staff Google Cloud project.
2. Open **Gmail** in the dashboard and grant `gmail.readonly`, OpenID and email.
   The registered Calendar callback URL is reused; browser-bound PKCE state
   starting with `gmail.` routes the callback to the separate Gmail handler.
3. Select work labels and/or exact email addresses. The union defines the scope.
   Google grants mailbox-wide read permission; the application enforces scope.
4. Optionally opt into OpenRouter/Claude analysis of imported text and task
   context. This is off by default and enforced on the server, including manual
   reanalysis. Attachments are never passed to the model.
5. Enable import and save. The private cron runs every five minutes.

Existing Google OAuth configuration remains in Vault. Gmail refresh credentials
are encrypted in a separate service-only table. Disconnect drops the Gmail token
without revoking Calendar's entire Google grant. Google can still require renewed
consent, including external apps in Testing; indefinite token validity is not promised.

### Separate work and personal accounts

The server-only `cos_calendar_config` JSON accepts `gmailAllowedEmail` for the
exact work mailbox. `allowedEmail` remains the personal Calendar account.
Omitting the optional field retains the original same-account behavior. Both
Gmail code exchange and callback checks use the work-mailbox configuration; the
Google account chooser receives it as a hint, not as proof of identity.

The two addresses are explicitly authorized identities of this app's single
owner. A verified Gmail callback issues a shared app session using the existing
Calendar owner's subject, or the Gmail subject if no Calendar connection exists
yet. Gmail, Calendar and Notes therefore accept the same session. The mailbox's
subject and encrypted refresh token stay in the separate Gmail connection; the
callback never changes Calendar credentials. Reconnecting an existing mailbox
still requires its original subject. Other Workspace users are not permitted.

For an OAuth app in Testing, add the work Google account under Google Auth
Platform → Audience → Test users. This Cloud setting is separate from the
server's allowed-address check and must be changed by the Cloud project owner.

## Reading boundaries

- Initial discovery: threads active in the last 30 days, up to 50 pilot threads.
- Get thread metadata first, then fetch selected message bodies only.
- First review: last 10 messages within 90 days, including sent replies.
- The owner can add 10 messages, up to 50, or explicitly expand that one thread
  to 180 days. Missing history/oversized or unavailable bodies are disclosed.
- A source is capped at 58k characters, newest messages first; each message body
  at 10k characters. Attachments are listed, not downloaded via attachment API,
  rendered, analyzed or followed. Embedded non-text MIME parts are discarded.
- Imported text is stored in private notes until the owner deletes it. This
  first pilot does not implement automatic retention or mailbox-wide backfill.

## Sync and review

Initial search is paginated across labels and address filters. A history anchor
is taken before discovery. Incremental history pages persist candidate IDs before
advancing their cursor. Candidates are scope-checked from headers in bounded
batches. Expired history causes a new bounded 30-day discovery, not a full-mailbox
download. Up to five threads are imported per tick. Capture and analysis use separate durable queues; up to five captured items are analyzed concurrently. The cron runs every minute, with the existing connection lock preventing overlap. Status reports discovery, captured threads, pending imports, ready reviews, pending analysis and analysis errors.

Pending reviews are preserved. New replies wait for the current review to be
applied. Repeating an import of the same message set does not create a second
review. Reviewed messages become context; each new suggestion must cite a new
trigger email and an exact action quote in a specifically dated source email.
Relative dates use that source email's date in the owner's time zone.

Unknown senders are offered as new people; same-name contacts require selection.
After the owner applies a selected participant, a private email-to-person binding
is remembered. Thread-to-project mappings can be saved through the Gmail API;
task review still supports the existing project selector.

Expansion supersedes the old review with a revision check and retains it as a
read-only source. It rebuilds proposals; an edited review must be saved first.
The old review cannot subsequently be applied through the notes API.

## Deployment / validation

Apply `supabase/gmail-schema.sql`, deploy the shared function dependency bundles
for `cos-google-calendar`, `cos-notes` and `telegram-webhook`, then install
`supabase/gmail-schedule.sql` and deploy the web bundle. Tables deny anon and
authenticated roles; service RPCs are invoker functions with role guards.

Node tests use synthetic messages and fake Google responses. A real end-to-end
mailbox test requires the owner to grant Google consent and choose the work
scope. No real mailbox is accessed during development or deployment.

Later phases: automatic context retrieval before questions, calibrated semantic
deduplication across channels, compact thread summaries with evidence retrieval,
and measured retention policy. The pilot deliberately keeps human confirmation
for every change to a task or project.


## 3.17.3 import recovery

Email evidence tolerates only whitespace differences (NBSP, CRLF, wrapping).
Quotes are restored to exact contiguous source spans within the referenced email;
changed words, cross-message joins and repeated triggers remain rejected. Existing
invalid_analysis results are revalidated without another paid model call. Recovery
checks AI consent and the inbox revision and never applies business changes.

The inbox refreshes Gmail progress while idle and accepts only newer revisions,
without replacing edits. Single long-message truncation is distinguished from
omitted older messages, so it no longer offers irrelevant history expansion.

## 3.17.4 bounded automatic retry

At most two failed invalid/unavailable analyses take slots in a later tick. The
analysis attempt counter permits only one automatic retry, including results
created before the counter existed. New captures keep the remaining slots.
Model instructions request short, contiguous quotes rather than stitched passages.

## 3.17.5 complete source passages

When original quoted lines or explicit ellipses omit an intervening sentence, a bounded local matcher
can restore the entire original passage within one email. All fragments must
match in order, with no paraphrasing; the entire restored passage is capped at 2,000 characters. Such suggestions are unchecked, have no newly inferred
task date, and display the restored context for explicit owner review.
