# Project brief: private first version

Runtime: existing Node.js 24 test runner and Deno Edge Function Web APIs; no new dependencies.

The existing `cos-notes` handler authenticates the owner session for both methods, checks the exact production Origin for PATCH, disallows query parameters, and applies its existing JSON body/content-type/timeout limits. A calendar connection may be disconnected; an unexpired owner session still authorizes this data.

- `GET /api/notes/projects/:uuid/brief` calls `getProjectBrief({store, projectId})`.
- `PATCH /api/notes/projects/:uuid/brief` reads JSON and calls `saveProjectBrief({store, projectId, data})`.
- Import these plus `ProjectBriefError` from `./project-brief.mjs`; catch that error and return only `{error: error.code}` with its status. Unexpected errors must remain generic.
- PATCH body has exactly `{revision, request_id, document}`. Revision is an integer 0–2147483646. UUID request IDs remain unchanged for retries of the **same** payload/base revision. Editing the payload or rebasing after conflict requires a new request ID.

## Snapshot

Both methods return `{project_id, revision, updated_at, document, history}`. PATCH additionally returns `replayed: boolean`. History is newest first, at most 20 elements of `{revision, created_at, changed_fields}`. Full old documents and request IDs are never returned.

A new brief reads as revision 0, `updated_at: null`, empty history, and:

```json
{"goal":"","current_state":"","next_step":"","checkpoint_label":"","checkpoint_on":null,"entries":[]}
```

Existing records never receive invented facts or dates. Reading does not create a row. Each explicit save advances revision once and atomically saves private history. An identical replay makes no changes and returns the **current** snapshot with `replayed: true`, even when a later save already exists. Client code must apply the returned revision/document together and preserve edits made during an in-flight request.

## Document constraints

All six keys are required; unknown keys are rejected. Limits count Unicode code points:

| Key | Value |
|---|---|
| goal | string ≤ 2000 |
| current_state | string ≤ 4000 |
| next_step | string ≤ 2000 |
| checkpoint_label | string ≤ 500 |
| checkpoint_on | null or actual day `YYYY-MM-DD`, years 0001–9999 |
| entries | array ≤ 60 |

Each entry has exactly `{id, kind, text, person, review_on, source, status}`. `id` is a UUID, unique within the document. Kind is `waiting`, `question`, or `decision`. Text is already trimmed, nonempty, at most 2000 code points. Person and source may be empty, at most 300 and 1000 code points respectively. Status is `open` or `resolved`. Review date is null or a valid day; decisions require null. NUL and unpaired UTF-16 surrogate code points are invalid. The entire encoded JSON document, including PostgreSQL JSONB separator spacing, is limited to 96 KiB. The enclosing HTTP body retains its 128 KiB limit.

UUIDs normalize to lowercase in the API. A removed entry is omitted from the next snapshot; previous snapshots remain private history. Date-only values are preserved as literal calendar days, without timezone conversion.

## Errors

| HTTP | Code | Meaning |
|---|---|---|
| 400 | invalid_project | malformed route/project UUID |
| 400 | invalid_project_brief_request | malformed body, request ID, or revision |
| 400 | invalid_project_brief | malformed document or database validation failure |
| 400 | project_brief_too_large | aggregate document exceeds budget |
| 404 | project_not_found | project does not exist |
| 409 | project_brief_conflict | stale revision or reused request ID with a different payload/base revision |
| 503 | project_brief_unavailable | unconfirmed response or storage failure |

On 409 the caller keeps the draft and explicitly reloads current state; it must never automatically overwrite a competing change. On an ambiguous failure, retry the unchanged request to resolve whether it committed.

## Database

`supabase/project-brief.sql` is additive source SQL, to be applied by a reviewed migration. Both new tables have RLS enabled, no anon/authenticated/public grants or policies. Only server `service_role` accesses them. Functions are SECURITY INVOKER, revoke default public execute, and verify the server role claim. Existing project/task/note policies are unchanged.

- `cos_project_briefs`: current document, revision, server update time; project foreign key.
- `cos_project_brief_history`: revision snapshots, changed fields, base revision and scoped request UUID; append privileges only for service role.
- `cos_get_project_brief(uuid)`: consistent current state/history in one statement snapshot.
- `cos_save_project_brief(uuid, integer, uuid, jsonb)`: locks the existing parent project row before replay/CAS checks, serializing initial creation and later updates without modifying the project row.
- `cos_valid_project_brief(jsonb)`: the database independently validates shape, lengths, dates, duplicates, and total bytes, including table CHECK constraints.

No tasks, messages, calendar events, model calls, or reminders are generated by a brief save.
