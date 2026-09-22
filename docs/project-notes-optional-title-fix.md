# Project notes: optional title database fix

The v3.5.0 interface creates project notes with `title: ''` and offers an optional
title input. The existing database still enforced
`project_notes_title_nonempty`. Creating a note therefore failed with PostgreSQL
error `23514`; clearing the title of an existing note failed for the same reason.

Apply `supabase/project-notes-optional-title.sql` to the existing application
database. It removes that one check and changes the title default to an empty
string. The title remains NOT NULL. Existing notes, foreign keys, permissions,
row-level policies, and media are preserved. No frontend change is required.

Run `supabase/tests/project-notes-optional-title-smoke.sql` against the same
database after applying the change. This rollback-only test exercises real
database constraints and the client role. Mocked browser API tests alone cannot
detect schema incompatibility.

Release verification also exercises the production interface: create an untitled
note, save text, reopen the project, and confirm that the text persists while the
title stays empty. Remove only the uniquely identified synthetic test note.
