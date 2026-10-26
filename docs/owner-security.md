# Owner access (v3.25.0)

The dashboard uses the existing Google owner login and opaque, hashed server sessions. Before login it renders only the login screen and does not fetch business records. A different Google identity, expired token, duplicate cookie or missing session is rejected. Logout removes the current server session. Cookies are Secure, HttpOnly and SameSite=Lax.

Browser database, media and AI calls pass through `cos-dashboard`. It validates the owner session and trusted origin, pins the upstream and schema, restricts resources and methods, and supplies service credentials only on the server. The browser no longer contains Supabase keys. API responses are private and not cached. Production scripts are external files under a restrictive Content Security Policy.

The database migration removes anonymous/authenticated access to public schema tables, sequences and application RPCs, enables RLS on all existing public tables, removes permissive policies and makes every storage bucket private. Service role access remains available for the authenticated server functions, Telegram and scheduled jobs. Future postgres-created objects do not grant public access by default. Extension-owned function ACLs can remain but the schema itself is inaccessible to client roles.

New media links require the owner session; no new reusable download signatures are issued. Existing short-lived download signatures expire naturally. No records or media are removed.

Legacy Edge Functions now require server credentials. Obsolete dashboard/export endpoints are retired. The existing morning digest uses its private Vault cron secret and sends only to the configured Telegram owner. Calendar and Gmail cron schedules are unchanged.

## Validation

- `node --test web/tests/dashboard-security.test.cjs`: anonymous, forged, expired and cross-site requests; upstream credential isolation; session media; logout; runtime legacy guard.
- `web/tests/dashboard-security-browser.cjs`: built assets with production CSP, no pre-login data requests, owner startup, narrow viewport and logout.
- `supabase/tests/owner-security-smoke.sql`: real database grants, RLS, storage and service-role compatibility, with rollback and no record writes.
- Full existing Node suite and production build.
- Deployment checks must probe public API/RPC/storage and legacy functions without using owner credentials.

## Operations

Do not roll back by restoring anonymous grants. Old clients that use direct Supabase access must migrate to an authenticated server API. Do not mint owner sessions for testing. Google login must use the configured owner identity.

The OAuth client secret previously pasted into chat should be rotated in Google Cloud and the existing private server configuration updated together. Public Supabase anon keys are not authentication after this migration. Never place service keys, OAuth secrets or session tokens into browser code or logs.

## Four-digit PIN (v3.27.0)

After Google owner authentication, enrollment or PIN unlock is mandatory before browser data access. `/api/session` reports the required next step; a server guard also protects Notes, Inbox, Gmail, Calendar, database, media and AI requests. OAuth state-checked callbacks and independently authenticated cron jobs keep their existing authorization. Telegram server processing is unchanged.

The owner sets and confirms exactly four digits, including leading zeros, on the dashboard. There is no default PIN. The browser sends it only in a same-origin HTTPS POST body and never stores it. A domain-separated HMAC with the private calendar token key is hashed with bcrypt cost 12 and a random salt in PostgreSQL. PINs and proofs must not be logged. Rotating the private token key also requires administrative PIN reset.

A second random HttpOnly Secure SameSite=Strict session cookie is bound to the current Google session and the PIN version. Its database grant expires after 12 hours; the browser cookie has session lifetime. Logout cascades revocation; the “Заблокировать” button revokes only the current browser's unlock proof. Restoring a Google session alone never unlocks data.

Failed PIN attempts are serialized by a row lock on the owner security row. Five failures impose a 15-minute account-wide lockout, including newly created Google sessions. Error returns commit counters; no exception rollback loses failed attempts. Setup cannot overwrite an existing PIN, including concurrent setup requests. Only server roles can read tables or execute PIN RPCs; both tables have RLS enabled.

Recovery is administrative: verify the owner outside the PIN flow, clear the stored PIN hash, increment `pin_version`, reset lockout state and revoke PIN sessions. Do not expose a client reset endpoint or mint owner sessions for testing. Tests use synthetic identities in temporary tables and roll back all changes.
