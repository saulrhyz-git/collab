# Project Management App

Stack: Next.js 14 App Router (API + frontend), Drizzle ORM over PostgreSQL with Row-Level Security, NextAuth v5 (JWT sessions), Socket.io for realtime.

## Getting started

Requirements: Node 20+, Docker (for local Postgres) or your own Postgres 16 instance.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start Postgres (or point `DATABASE_URL` at an existing instance):

   ```bash
   docker compose up -d
   ```

3. A `.env` already exists in this folder (gitignored, not committed) with a generated `AUTH_SECRET` and the super-admin credentials from step 8 below pre-filled. If you're setting this up somewhere else, copy `.env.example` instead and fill in real values — generate `AUTH_SECRET` with `npx auth secret`.

4. Push the schema to the database (creates tables + enums; RLS policies are separate — see below):

   ```bash
   npm run db:push
   ```

5. Apply Row-Level Security. `db:push` only creates tables from `db/schema.ts` — the policies, helper functions, and the one-personal-workspace-per-owner constraint live in raw SQL and must be run once, after the tables exist:

   ```bash
   psql "$DATABASE_URL" -f db/rls-policies.sql
   ```

   This needs to be run by a **superuser** connection (the default docker-compose Postgres's `app` user already is one — for your own Postgres instance, connect as `postgres` or whichever role has `SUPERUSER`, not necessarily the same role the app's `DATABASE_URL` uses day to day). The script creates a narrowly-scoped, no-login `rls_helper` role with the `BYPASSRLS` attribute — required so a couple of membership-check functions can query `workspace_members`/`project_members` without recursing into the very policy that's calling them (see the comment above `is_workspace_member()` in the file for why). If you run it as a non-superuser and it fails on the `CREATE ROLE ... BYPASSRLS` step with "permission denied", re-connect as a superuser and re-run the file — it's safe to run more than once.

6. Start the app:

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000` — you'll land on `/login`, where you can create an account (this auto-provisions your personal workspace). After signing in you land on that workspace's dashboard, which lists your projects and lets you create new ones — see "Default workspace & project management" below.

7. (Optional, for live Kanban updates across browser tabs/users) start the realtime server in a second terminal:

   ```bash
   npm run socket
   ```

8. Seed the local super-admin account (credentials come from `.env` — see `SEED_SUPERADMIN_*`):

   ```bash
   npm run db:seed
   ```

   This creates (or promotes, if it already exists) the account and flips `is_super_admin` on it. A super admin bypasses workspace/project membership checks everywhere — every workspace shows up in their switcher, they can manage any project's members and tasks, and RLS independently enforces the same bypass at the database level (see `auth/super-admin.ts` and the `is_super_admin()` function in `db/rls-policies.sql`). It's a genuine platform-wide override, not scoped to any one workspace — treat the password like the keys to everything.

### Updating an already-running install

If you already had this app running, re-run steps 4 and 5 after pulling new code — both the clients/dashboard feature (new `clients` table, `projects.client_id`) and the RLS fixes below (existing tables, policies only) need it:

```bash
npm run db:push
psql "$DATABASE_URL" -f db/rls-policies.sql   # must be a superuser connection — see below
```

`db:push` only adds what's new (it won't touch your existing rows), and `rls-policies.sql` is idempotent (`CREATE OR REPLACE FUNCTION`, `CREATE POLICY` guarded by the policies being dropped/recreated on each run) — safe to re-run any time the schema or policies change. Restart `npm run dev` afterward.

**This one is not optional if you set up the app before this note was added.** Two real bugs in `db/rls-policies.sql` meant an ordinary (non-super-admin) account couldn't reliably sign up, log back in, or create a project — masked in earlier testing because everything was exercised through the seeded super admin, which bypasses both:

- **`stack depth limit exceeded`** on ordinary requests. `is_workspace_member()`, `is_workspace_admin()`, and `is_project_member()` each query `workspace_members`/`project_members` to check membership — but those two tables' OWN row-security policies call the same functions, so evaluating one re-triggered the policy that was calling it, forever, until Postgres gave up. Fixed by making the three functions `SECURITY DEFINER`, owned by a new `rls_helper` role with the `BYPASSRLS` attribute, so their internal lookups skip row security instead of recursing into it.
- **`new row violates row-level security policy`** on ordinary signup and project creation. Two compounding issues: (1) a few bootstrap inserts (a brand-new personal workspace, a brand-new project) asked Postgres to `RETURNING` the row they'd just created, but the row's SELECT policy required a membership row that only existed after the *next* statement — fixed in `auth/signup.ts`, `services/workspaces.ts`, and `services/projects.ts` by pre-generating the id, dropping `.returning()`, and re-`SELECT`ing after the membership row exists. (2) `project_members_insert` had no branch at all for "the project's own creator adding themselves as `PROJECT_ADMIN`" — anyone who wasn't already a workspace admin creating a project would hit this. Fixed by adding that bootstrap branch, plus new bypass helper functions (`is_workspace_owner`, `project_workspace_id`, `is_project_creator`, `has_pending_workspace_invite`, `has_pending_project_invite`) for every other spot where a policy needed to check a fact about a row it couldn't yet see under its own table's RLS.

Both classes of bug were verified against a real (embedded) Postgres instance end to end — signup, shared-workspace creation, project creation as an ordinary member, and invite acceptance for an invite sent before the invitee had an account — before and after the fix.

### Other useful scripts

- `npm run typecheck` — `tsc --noEmit` across the whole project.
- `npm run db:studio` — Drizzle Studio, a GUI for browsing the database.
- `npm run db:generate` — generate a versioned SQL migration from schema changes instead of `db:push` (recommended once you have real data you don't want to risk with a diff-and-apply push).
- `npm run db:seed` — create/promote the local super-admin account from `.env`.

### Notes on what's stubbed

- `services/notifications.ts` logs to the console instead of actually sending email — swap in a real provider (Resend, SES, Postmark) before this goes further than local use.
- Beyond the seeded super admin, the fastest way to get a second test user is to sign up a second account in an incognito window and invite it to a project from the first account's UI (project page → collaborators modal).

## Default workspace & project management

Every account gets a personal workspace on signup (see `auth/signup.ts`). Signing in lands on that workspace's dashboard (`app/dashboard-shell.tsx`) — a proper "what's going on" landing page, not a bare project grid: a greeting, four stat cards (active engagements, my open tasks, due this week, overdue), a "My tasks" widget and a workspace-wide "Upcoming deadlines" widget, a "Recent activity" feed, and the full client/engagement roster below. A super admin sees every project across every workspace here, not just ones they're a member of.

### Clients & engagements (legal / consultancy framing)

Professional-services work — legal matters, consulting engagements, agency retainers — treats "the client" as a first-class thing, not just a project label. `clients` (`db/schema.ts`) is a workspace-scoped roster: name, primary contact name/email, notes. `projects.client_id` is a nullable FK to it — a project is an "engagement" when it's set, or stays an ordinary internal project when it's left blank (solo product work, internal ops).

- `services/clients.ts` — `createClient`, `listClientsForWorkspace`, `getClient` (client + its non-archived engagements, visibility-filtered same as the project list), `updateClient` (creator or workspace admin only), `archiveClient` (workspace admin only, soft delete).
- Creating a project (`components/CreateProjectDialog.tsx`) lets you pick an existing client, add a new one inline without leaving the dialog, or leave it as "No client — internal project."
- `components/CreateClientDialog.tsx` lets you log a client relationship on its own — matters/accounts often get opened before the first task does.
- `app/clients/[clientId]/` — a client detail page: contact info, notes, and every engagement on record for them, with a "New engagement" button that preselects that client.
- On the dashboard, engagements are grouped by client (linking to the client detail page), with an "Internal / no client" bucket for everything else. Each engagement card shows a task-completion progress bar and an overdue count.

New routes: `GET/POST /api/workspaces/[workspaceId]/clients`, `GET/PATCH/DELETE /api/clients/[clientId]`, `GET /api/workspaces/[workspaceId]/dashboard` (the aggregate endpoint the landing page reads in one call — stats, my tasks, upcoming deadlines, recent activity, and the clients/engagements rollup; see `services/dashboard.ts`).

Opening a project goes to `app/projects/[projectId]/page.tsx` → `project-shell.tsx`, which switches between three views of the same task data via tabs:

- **Board** (`components/KanbanBoard.tsx`) — drag-and-drop columns by status (Backlog/To Do/In Progress/In Review/Done), fractional-index positioning so reordering never rewrites the whole column, realtime sync across tabs/users via Socket.io (`task:moved`, `task:created`).
- **List** (`components/TaskListView.tsx`) — tasks grouped by status in collapsible sections, one level of subtask nesting indented under its parent, inline quick-add per group.
- **Gantt** (`components/GanttChart.tsx`) — a custom-built timeline (no third-party Gantt library): sticky task-label column, day/month grid, bars positioned by `startDate`/`dueDate`, an SVG overlay drawing elbow-connector lines for dependencies and a dashed line marking today, and a footer listing tasks with no dates yet.

Clicking any task in any view opens `components/TaskDetailPanel.tsx` (a right-side slide-over built on Radix Dialog, see `components/ui/sheet.tsx`): editable title, status, priority, assignee, dates, and description; a subtasks list; add/remove dependencies (with cycle detection — see below); and a comment thread.

New data model to support this (`db/schema.ts`):

- `tasks` gained `parent_task_id` (self-referencing FK, one level of nesting enforced at the service layer) and `start_date`.
- `task_dependencies` — predecessor/successor task pairs plus a `type` (`FINISH_TO_START`, `START_TO_START`, `FINISH_TO_FINISH`, `START_TO_FINISH`, matching MS Project/Asana Timeline semantics). `services/task-dependencies.ts` does a BFS cycle check (`wouldCreateCycle`) before allowing an insert and throws `CyclicDependencyError` (mapped to HTTP 409) if adding the edge would create a loop.
- `task_comments` — flat per-task comment thread, delete restricted to the author or a `PROJECT_ADMIN`.

New routes: `GET/POST /api/workspaces/[workspaceId]/projects`, `GET/PATCH/DELETE /api/projects/[projectId]`, `GET/PATCH /api/projects/[projectId]/tasks/[taskId]` (task detail), `GET /api/projects/[projectId]/dependencies` (whole-project dependency list, for the Gantt overlay), `POST /api/projects/[projectId]/tasks/[taskId]/dependencies` and `DELETE .../dependencies/[dependencyId]`, `GET/POST /api/projects/[projectId]/tasks/[taskId]/comments` and `DELETE .../comments/[commentId]`.

Out of scope for this pass, deliberately: automations/rules, custom fields, and time tracking. The data model doesn't preclude adding them later.

## File map

- `db/schema.ts` — Drizzle schema: workspaces, clients, projects, tasks (+ subtasks + dependencies + comments), memberships, invitations, activity log.
- `db/rls-policies.sql` — RLS enablement + policies, run after the Drizzle migration. Includes the `is_super_admin()` bypass baked into every membership-check function.
- `db/client.ts` — Postgres pool, Drizzle instance, and the `AsyncLocalStorage`-based `runWithRlsContext` wrapper that sets the `app.current_user_id` / `app.current_workspace_id` session GUCs every RLS policy reads, transparently, for every query issued through `db` during a request. `db/with-rls-context.ts` re-exports the same function for backwards compatibility.
- `auth/signup.ts` — signup + automatic personal workspace provisioning.
- `auth/auth.config.ts`, `auth/index.ts` — NextAuth v5 credentials provider, JWT callbacks.
- `auth/workspace-context.middleware.ts` — resolves and **verifies** the active workspace on every request; also where the super-admin bypass short-circuits the membership lookup.
- `auth/super-admin.ts` — `isSuperAdmin(userId)` check used by the middleware, services, and the realtime server.
- `services/clients.ts` — `createClient`, `listClientsForWorkspace`, `getClient`, `updateClient`, `archiveClient`.
- `services/projects.ts` — `createProject`, `listProjectsForWorkspace` (super admin sees all), `getProject`, `updateProject`, `archiveProject`.
- `services/tasks.ts` — CRUD plus `getTaskDetail` (task + assignee + reporter + subtasks + dependency edges in one call).
- `services/task-dependencies.ts` — add/remove dependency, cycle detection.
- `services/task-comments.ts` — list/add/delete comments.
- `services/dashboard.ts` — `getWorkspaceDashboard`, the landing page's single aggregate query.
- `services/invitations.ts` — `sendProjectInvite`, `acceptProjectInvite`, `revokeProjectInvite`.
- `services/workspace-members.ts` — `removeWorkspaceMember`, with task-reassignment handling.
- `services/notifications.ts` — email/in-app adapters.
- `scripts/seed-superadmin.ts` — creates/promotes the super admin account from `.env`.
- `app/api/**/route.ts` — Next.js route handlers wiring the above into HTTP.
- `app/dashboard-shell.tsx` — the post-login landing page: stats, my tasks, upcoming deadlines, recent activity, clients/engagements roster.
- `app/projects/[projectId]/` — project detail page and the Board/List/Gantt tab shell.
- `app/clients/[clientId]/` — client detail page (contact info, notes, engagements).
- `lib/format-activity.ts` — turns an activity-log row into a human sentence for the recent-activity feed.
- `components/*.tsx` — WorkspaceSelector, ProjectCollaboratorModal, KanbanBoard, TaskListView, GanttChart, TaskDetailPanel, CreateProjectDialog, CreateClientDialog, plus the shadcn/ui primitives under `components/ui/`.
- `realtime/socket-server.ts` — Socket.io server with room-based project isolation.

## Step 5: Security & edge cases

### Revoking an invitation before acceptance

`revokeProjectInvite` (in `services/invitations.ts`) only transitions an invite out of `PENDING` — it never deletes the row, so there's a permanent audit trail of who revoked what and when. Authorization is restricted to the original inviter or a workspace admin; a `PROJECT_ADMIN` who didn't send the invite cannot revoke it unless they're also a workspace admin, which keeps a compromised or careless project admin from mass-revoking invites sent by others.

The token itself is never invalidated at the crypto level (it's just a random value) — instead, `acceptProjectInvite` re-checks `status === 'PENDING'` before honoring any token, so a revoked token fails with a clear "already resolved" error rather than a generic 404 that would leak whether the invite ever existed.

Race condition: if a user clicks "Accept" in the same instant an admin clicks "Revoke," both operations hit the same row inside a transaction. Whichever commits first wins; the loser's `UPDATE ... WHERE status = 'PENDING'` affects zero rows, and the app layer treats a zero-row update as "already resolved" rather than silently succeeding.

### Removing a user from a workspace

Handled by `removeWorkspaceMember` in `services/workspace-members.ts`. The workspace owner can never be removed through this path — ownership must be transferred first — which prevents a workspace from ending up ownerless. Assigned tasks are **unassigned, not deleted or cascaded**: `assignee_id` is set to null so the work item stays visible on the board and gets picked up by someone else, rather than vanishing along with the person who left. Reporter history is preserved for audit purposes even though the reporter can no longer log in to that workspace. Project-level memberships in that workspace are cleaned up so the removed user can't still see private projects via a stale `project_members` row, and the whole operation is wrapped in one transaction so a partial removal (e.g. tasks unassigned but membership row still present) can't happen.

One nuance: a user removed from a workspace they only had *project-scoped guest* access to (via the `workspace_members.scoped_to_project_id` column set during `acceptProjectInvite`) is functionally the same removal path — they just never had visibility into anything beyond that one project to begin with, so there's nothing extra to clean up.

### IDOR protection across workspace/project routes

Three layers, deliberately redundant so a bug in any single one doesn't equal a breach:

1. **Middleware-level membership check.** `resolveRequestContext` (in `auth/workspace-context.middleware.ts`) re-verifies, on every request, that the authenticated user has a `workspace_members` row for whatever workspace id shows up in the cookie or header. A forged `active_workspace_id` cookie pointing at someone else's workspace fails here before any query runs — the cookie is a UX convenience, never a trust boundary.
2. **Application-level authorization inside services.** `sendProjectInvite`, `removeWorkspaceMember`, etc. independently check role membership before touching data, so even a route that forgets to call the middleware wrapper still can't silently authorize a write.
3. **Row-Level Security as the backstop.** Every query — regardless of which route or service issued it — runs inside `withRlsContext`, so even a completely new, unreviewed endpoint that skips both of the above still can't read or write rows outside the caller's workspace/project, because Postgres itself won't return them. `FORCE ROW LEVEL SECURITY` ensures this holds even if the app's DB role is accidentally granted table-owner privileges.

Practical IDOR scenario this stops: a user in Workspace A guesses or enumerates a `projectId` belonging to Workspace B and calls `GET /api/projects/:projectId/tasks`. Layer 1 doesn't even apply here (project id isn't the workspace cookie), so layer 3 is what actually blocks it — `can_access_project()` evaluates false because the requester has no `workspace_members` row for Workspace B and no `project_members` row for that project, so the RLS `SELECT` policy returns zero rows and the API responds with an empty list rather than leaking a 403 (which would confirm the project's existence) or, worse, the data itself.

Task and invitation ids are UUIDv4 (128 bits of entropy), not sequential integers, specifically so enumeration isn't a viable attack even before RLS is considered — defense in depth rather than reliance on any single control.
