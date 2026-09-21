# Google Calendar sync: preparatory implementation

Status: draft foundation. This does not connect an account, call Google, deploy a worker, or change the production UI.

## Intended behavior

The application is the source of truth. Synchronize task deadlines and meetings into a dedicated calendar in the owner's Google account. Changes in Google do not change task dates.

| Source | Calendar representation |
| --- | --- |
| Task deadline date | Transparent all-day event; exclusive end is the next calendar day |
| Task deadline timestamp | Exact instant; transparent one-minute deadline marker, not a work-duration estimate |
| Task with no deadline | No deadline event; planned and next-check dates are not substituted |
| Meeting | Actual start and end, preserving timezone offsets and daylight-saving transitions |
| Completed task or meeting | Keep the event with a check mark and disable reminders |
| Cancelled record or removed task deadline | Remove only the positively identified managed event |
| Invalid data or meeting without end | Keep any existing event; expose a correction-needed status |

Include already-existing dated records in the initial import, including completed history. Never invent a deadline or silently discard records because a page limit was reached. No attendees or invitations are generated. Descriptions include the app link and optional project name, not private notes or transcripts.

## Implemented

- `web/calendar/projector.mjs` converts a commitment or meeting row into an event, explicit absence, or an error.
- `planCalendarChange` plans insert/update/delete/noop/hold operations and checks event ownership. It performs no network I/O.
- Event IDs are deterministic within a persisted generation. Repeated projection or date changes within that generation preserve identity.
- `web/tests/google-calendar.test.cjs` covers date rollover, leap years, timestamps, DST, ownership, cancellation, completion, generations, and invalid data.
- A GitHub Actions workflow runs the calendar tests on Node.js 24 without credentials.

Run locally with Node.js 24:

```sh
cd web
node --test tests/google-calendar.test.cjs
```

Contract: pass canonical PostgREST date strings and timestamp strings with an explicit offset, and the target calendar's validated IANA timezone. A timestamp has priority over a date; a disagreement produces a warning. Timezone must come from the calendar/connection configuration, never the server default.

## Required before activation

1. Authenticate the application owner. The current anonymous API access is not proof of the calendar owner's identity. The OAuth start, callback, disconnect and status endpoints need owner authorization; the callback also needs single-use state and an exact allowed redirect.
2. Configure a Google Cloud OAuth web client and Calendar API. Request offline access and the narrowest scope that supports the chosen dedicated-calendar workflow. Keep the client secret and refresh tokens server-side in storage inaccessible to anonymous API clients. Never include them in HTML or this public repository. Google consent/testing configuration must support the desired long-lived use.
3. Persist the connection, calendar ID, timezone and a binding for each source record. Scope bindings by connection and calendar as well as source kind and ID. Store generation, event ID, last source version, sync state and last error.
4. Implement a durable queue/outbox or equivalent polling reconciliation with complete pagination. Serialize work per binding, reread the current source before applying stale queued work, retry transient failures with backoff, and renew access tokens server-side.
5. Connect the UI to owner-only connection status and a list of records needing correction. Add a manual retry. Meetings without an end time must be visible there.
6. Run the real Google lifecycle and authorization tests described below before merging and activating.

## Deletion, reactivation, and retries

A Google event deleted with an ID may leave a cancelled tombstone. One source UUID does not guarantee that the same Google ID can be used forever.

The executor must persist the current generation before any create request. On a retry after an unknown outcome, reuse that generation and ID; on a duplicate response, read the event and verify ownership before updating. Never treat every conflict as success.

When deletion is confirmed, retain the binding as deleted. When the source becomes eligible again, atomically advance its generation and persist the next ID before creation. Pass that generation to the projector. The projector uses a base-16 generation suffix, within Google's permitted event-ID alphabet. Do not advance a generation for every retry or let late old-generation work delete a new event.

A missing/tombstone event or access error needs explicit resolution. A 404 alone does not distinguish missing access from a missing event. The planner holds tombstones and ownership mismatches. Manual deletion in Google should be shown as a conflict for the owner to resolve; do not silently create repeated replacements.

Errors projecting a row are not deletion instructions. Likewise, absence from a failed or incomplete list is not proof of source deletion. Source hard deletions require durable tombstones or reconciliation against a verified complete snapshot.

## Release verification

Use a disposable calendar authorized by the owner. Verify initial import with pagination, create/update/completion/cancel/reactivate, duplicate retries after timeouts, stale queued work, token renewal, disconnect/revocation, calendar access loss, missing meeting end, and timezone/DST handling. Confirm unrelated events are untouched and anonymous users cannot read tokens or control the connection.

Unit tests do not demonstrate that any event has reached Google. Keep this change a draft until the server integration, account connection and real API checks are complete.

## References

- [Create events and caller-specified IDs](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Event fields and cancelled-event behavior](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [API error handling](https://developers.google.com/workspace/calendar/api/guides/errors)
- [Web-server OAuth and offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar authorization scopes](https://developers.google.com/workspace/calendar/api/auth)
