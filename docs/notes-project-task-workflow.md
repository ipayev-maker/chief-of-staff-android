# Notes, projects and task creation

## User flow

A note received from Telegram or created in the Notes section remains one
`quick_notes` row. Assigning a project makes that same row available in the
project's Notes tab. Editing, moving or archiving it uses the owner API and its
existing revision precondition. It must never be copied into `project_notes`.

Existing project notes and their media remain available. They are not migrated
or merged into private Telegram notes as part of this release.

The Create task action uses selected note text, or the note text when nothing
is selected. It opens an editable task draft. The user can check the text,
project, participant and dates before creating anything. Cancelling creates
no task. Dates and participants are not guessed automatically.

The confirmed task and its source link are saved in one transaction. The
source note remains intact. A saved task can open its original note. Each
draft has a stable request ID so a retry after a lost response cannot create
a second task. A changed payload cannot reuse a previously committed request.

## Access and compatibility

Project views of private notes use the same owner session as global Notes.
Requests without that session return no private note text. Source links also
remain behind the owner API. Database role grants and existing legacy note
access are not expanded.

Only the fields the user confirms in the task form are copied to the existing
task entity. Original note text and Telegram identifiers are not copied into
the legacy inbox or task metadata.

Google Calendar continues to synchronize the task through its existing
mechanism. This release does not change calendar rules, Google authorization
expiry, or project process templates.

## Verification

Exercise project-scoped note pagination, edits and moves between projects,
stale-response protection, draft cancellation, source links, and uncertain
task submissions. API tests cover owner authorization, input validation and
idempotent retries. The database smoke test uses a transaction and rolls back
every synthetic note, task and link.
