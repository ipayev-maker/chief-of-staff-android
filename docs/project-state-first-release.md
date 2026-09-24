# Project state: first release (v3.11.0)

## User outcome
Opening a project shows its state, intended result, next step, optional checkpoint, expectations, questions and decisions. Missing information remains missing. The screen does not infer a production stage or that an empty task list means a stopped or completed project.

## Data boundaries
- Existing tasks, project media notes and meetings provide navigable source records. Date fields describe their actual recorded creation/update/meeting dates, not inferred completion.
- Owner-provided context is separate from existing task/note data. Fields and dates may remain blank.
- Expectation/question review dates and project checkpoints are planning context. They do not create tasks, calendar events or messages. Task deadlines and Google Calendar behavior remain attached to existing tasks/meetings.
- Private context is read and saved through the existing Google-owner cookie session. The browser receives no server credentials. New tables use RLS with service-only privileges.
- Unsaved drafts are bounded and scoped by project in session storage; if browser storage is unavailable, the editor offers a draft download before sign-in.
- Every save uses revision comparison and a stable request UUID. Repeating an acknowledged request returns the current snapshot without another write. Changed request reuse or stale revision returns conflict.
- History records changed fields and preserves private revision snapshots. This release does not extract facts from note text or run an AI model.

## Architecture
`web/project-brief.js` contains the independent view/model; `web/project-brief.css` contains scoped styles. `web/index.html` supplies current project records and guarded source navigation. The notes handler delegates `/projects/:id/brief` to its server-only module. See `project-brief-contract.md` for API/SQL details.

## Verification and deployment
Runtime uses the existing Node.js/Deno Web APIs without added package dependencies. Run `npm --prefix web test` and `npm --prefix web run build`. Apply `supabase/project-brief.sql` through the Supabase migration tool, deploy cos-notes with all relative dependencies, then publish the web app through the existing Git/Vercel integration.

Preview builds include `_project-brief-preview.html` and `_project-brief-layout.html` for form verification with memory-only synthetic data. Production builds remove both pages. Real user tasks/notes should not be created or deleted for verification.
