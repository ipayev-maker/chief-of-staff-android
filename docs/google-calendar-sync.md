# Google Calendar sync — v3.4.0

Status at the 2026-09-22 release handoff: the OAuth handler and reconciliation worker are implemented; Supabase Edge Function `cos-google-calendar` version 2 is deployed, Vault configuration is provisioned, and the cron job is active. No owner connection exists yet. Google consent and a real Google event lifecycle have **not** been completed. Deploying the connection UI is the next step; owner consent is an activation step after release, not a prerequisite for merging this implementation.

## Behavior

Chief of Staff is the source of truth. The integration creates a separate calendar named **Chief of Staff** in the configured owner's Google account. It does not target the primary calendar. Task and meeting dates are never written back from Google to the application.

| Source | Calendar representation |
| --- | --- |
| Task deadline date | Transparent all-day event; exclusive end is the next calendar day |
| Task deadline timestamp | Exact instant; transparent one-minute deadline marker, not a work-duration estimate |
| Task with no deadline | No deadline event; planned and next-check dates are not substituted |
| Meeting | Actual start and end; explicit timestamp offsets and the configured IANA timezone are retained semantically |
| Completed task or meeting | Keep the event with a check mark and disable reminders |
| Cancelled record or removed task deadline | Remove only a positively identified managed event |
| Invalid source or meeting without an end | Preserve any existing event and report a correction-needed status |

Initial reconciliation includes existing dated records and completed history, with complete pagination. No attendees or invitations are generated; event mutations use `sendUpdates=none`. Event content includes the record title, the application link and, for meetings, location/link. Private task details, notes and transcripts are not exported. The projector supports an optional project name, but the current worker does not supply it.

## Implemented components

| File | Responsibility |
| --- | --- |
| `web/calendar/projector.mjs` | Pure projection into an event, explicit absence, or validation error; deterministic event IDs and generation-aware change planning |
| `supabase/functions/cos-google-calendar/google.mjs` | Google OAuth/PKCE, scope and owner verification, access-token renewal, AES-GCM token encryption, bounded Google API requests and sanitized errors |
| `supabase/functions/cos-google-calendar/store.mjs` | Server-only PostgREST adapter, complete paginated reads, guarded mutations and bounded requests; no credentials in errors |
| `supabase/functions/cos-google-calendar/handler.mjs` | Browser-bound OAuth state, owner session, connection/status endpoints, serialization and worker invocation |
| `supabase/functions/cos-google-calendar/sync.mjs` | Bounded polling reconciliation, durable operation intent, generation handling, ownership checks and retry recovery |
| `supabase/functions/cos-google-calendar/index.ts` | Deno entry point; loads Vault-backed configuration through a restricted RPC and caches it for 60 seconds |
| `supabase/calendar-schema.sql` | Connection, OAuth state, session, binding and lease tables; RLS, grants and restricted configuration/lock RPCs |
| `supabase/calendar-schedule.sql` | One-minute reconciliation schedule, conditional on an established connection |
| `web/vercel.json` | Same-origin `/api/google-calendar/:path*` rewrite to the Edge Function, with caching disabled |

Backend modules use portable Web APIs on Supabase Edge/Deno and Node.js 24 tests, without third-party runtime packages. Source dates must be canonical date strings; timestamps must include an explicit UTC offset. A deadline timestamp takes priority over a date. The connection's validated IANA timezone is used, never the server's default timezone.

## OAuth and endpoint contract

Use a Google Cloud **Web application** OAuth client with the Calendar API enabled.

- Authorized JavaScript origins: empty; this implementation uses server redirects, not a browser Google OAuth SDK.
- Authorized redirect URI: `https://chief-of-staff-v3-live.vercel.app/api/google-calendar/callback` — exactly, with no trailing slash or preview URL.
- Requested scopes: `openid email https://www.googleapis.com/auth/calendar.app.created`.
- The narrow Calendar scope permits management of calendars created by this app. Their IDs are persisted; the implementation does not depend on enumerating all calendars through CalendarList.
- Authorization requests use offline access, explicit consent/account selection, and PKCE S256. The callback checks granted scopes and a verified Google userinfo identity against the configured owner email and any existing Google subject.

| Endpoint under `/api/google-calendar` | Method | Contract |
| --- | --- | --- |
| `/start` | POST | Same-origin form with a validated `time_zone`; creates a ten-minute OAuth state bound to an HttpOnly browser cookie, then redirects to Google |
| `/callback` | GET | Atomically consumes the state, exchanges the code, verifies the owner, saves the connection/calendar ID and issues an owner session; redirects back to the app |
| `/status` | GET | Without a valid owner session: only `{authenticated:false,configured:true}`; with one: connection summary, counts and source issues, never tokens |
| `/sync` | POST | Same-origin owner session required; runs one bounded reconciliation pass |
| `/disconnect` | POST | Same-origin owner session required; removes the stored refresh-token ciphertext, marks the connection disconnected and invalidates owner sessions |
| `/tick` | POST | Server scheduler only; requires the configured cron bearer secret and acquires the same lease |

`/start` does not assume an existing app login: Google verifies ownership during the callback. Same-origin checks alone are not owner authentication. Flow and session cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, use the `__Host-` prefix, and contain opaque random values. Sessions expire after 30 days; only their hashes are stored.

The callback creates the dedicated calendar only on first connection. Reconnection reuses its persisted ID and timezone. An uncertain calendar-create outcome leaves provisioning blocked for operator investigation rather than blindly creating another calendar. The callback does not run the initial import inline; cron performs it after connection.

Disconnect stops synchronization and removes local token access. It does **not** call Google's token-revocation endpoint or delete existing Google events/calendar. Google-side permission revocation is a separate owner action. Invalid refresh credentials move the connection to `needs_reconnect`.

For a personal account, configure an External audience and add the owner as a test user when the client is in Testing. Google's Testing-mode refresh-token lifetime for this scope can require reconnection after seven days; use an appropriate publishing status for ongoing operation. Publishing status and any applicable personal-use verification exception are separate concerns.

## Server configuration and schedule

Provision one JSON secret named `cos_calendar_config` in **Supabase Vault**, outside source control. Its fields are:

| Field | Purpose |
| --- | --- |
| `clientId` | Google OAuth web client ID |
| `clientSecret` | Google OAuth client secret; server only |
| `allowedEmail` | Configured owner's allowed email address; kept in Vault |
| `tokenKey` | Base64-encoded random 32-byte AES-GCM key for refresh-token envelopes |
| `cronSecret` | Independent high-entropy bearer secret for `/tick` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied to the Edge runtime. The service key is never delivered to the browser. Calendar tables deny access to `anon` and `authenticated` and have RLS enabled/forced. The service-only public `cos_calendar_get_config` RPC delegates to a restricted function in the non-exposed `cos_calendar_private` schema; it does not grant broad access to decrypted Vault secrets. OAuth/session state and refresh-token ciphertext are server-only. Changing `tokenKey` requires migrating existing ciphertext or reconnecting; it is not a transparent rotation.

Deployment order: apply `calendar-schema.sql`, provision Vault configuration, deploy the Edge Function and its imported modules/projector, then install `calendar-schedule.sql`. The function must allow requests to reach its own OAuth/session/cron authorization checks; Supabase's JWT gateway must not reject the cookie-based callback or the independent cron bearer first.

The named cron job `cos-google-calendar-sync` runs every minute through `pg_cron` and `pg_net`. It reads `cronSecret` inside Postgres and POSTs to `/functions/v1/cos-google-calendar/tick` only when the singleton connection has `status='connected'`. An active schedule without a connection therefore makes no Google synchronization calls. The schedule's HTTP timeout is 60 seconds; each reconciliation pass is bounded to 40 seconds and 20 Google mutations. Callback, manual sync, disconnect and cron share a 180-second database lease to avoid overlapping work.

## Reconciliation, recovery and current limits

Each pass verifies access to the dedicated calendar, then reads complete paginated snapshots of tasks, meetings and connection bindings. A failed/incomplete listing never authorizes deletion. After a complete snapshot identifies a candidate, the worker rereads that source record before remote work, including removal of a hard-deleted source. It changes only calendar-integration tables, not source task/meeting rows.

Bindings persist connection key, source kind/ID, event ID, generation, desired-state hash, state, pending operation and error/attempt timestamps. The worker persists an operation intent before changing Google. Retrying an uncertain create uses the same generation/ID and checks the returned event's ownership; a conflict is never treated blindly as success. Updates/deletes use the observed ETag with `If-Match`. Confirmed deletion preserves the binding; reactivation advances the generation before creation. An uncertain in-flight create followed by source cancellation remains tracked until it can be resolved.

Pending/error records with a recent failure wait at least 60 seconds before retry. Work is ordered by oldest attempt; time or mutation limits defer remaining records to later passes. This is bounded polling with a fixed retry delay, not an outbox or exponential-backoff implementation.

**Unchanged active bindings are skipped by desired-state hash without an event GET.** The calendar-access GET still occurs, but manual Google event edits/deletions are not continuously detected. They become observable when the corresponding source projection changes or other work requires that event to be read. A manual sync uses this same fast path and is not a forced remote audit. Status counts describe stored binding/source state, not freshly verified Google contents.

When read, missing/deleted events, ownership mismatches, attendee/recurrence changes and ETag conflicts become a `conflict`; the worker does not silently create replacement events. Conflicts are held rather than automatically retried. Safe operator resolution is still required; the status response exposes the issue but no automated conflict-reset endpoint is implemented. Ordinary edits to an owned Google event can be overwritten from the source when it next changes. No Google change is imported into Chief of Staff.

## Verification and release boundary

From the repository root, with Node.js 24 and no credentials:

```sh
cd web
npm test
npm run build
```

`npm test` runs every `web/tests/*.test.cjs`, including existing UI regressions and calendar projector, Google adapter, store, handler and reconciliation tests. External services are replaced by test doubles. GitHub Actions runs these tests and the local static build for web/backend/calendar configuration changes. The build reads the committed `web/index.html`; it does not download the old mutable `live` export.

These checks establish local contracts, not a successful Google connection. After the release UI is available, the owner must grant consent. Then verify against the dedicated calendar: initial import, create/update/completion/cancel/reactivation, token renewal, retry after an uncertain response, disconnect/reconnect, missing meeting end, timezone/DST behavior, held conflicts, and calendar access loss. Confirm unrelated events remain untouched and anonymous callers cannot access connection details/tokens or invoke owner controls. Record those real API results separately; they are not yet claimed by this release handoff.

## References

- [Create events and caller-specified IDs](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Event fields and cancelled-event behavior](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [API error handling](https://developers.google.com/workspace/calendar/api/guides/errors)
- [Web-server OAuth and offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar authorization scopes](https://developers.google.com/workspace/calendar/api/auth)
