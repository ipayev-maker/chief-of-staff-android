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
