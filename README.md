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

If you already had this app running, re-run steps 4 and 5 after pulling new code — both the clients/dashboard feature (new `clients` table, `projects.client_id`) and the RLS fixes below (existing tables, policies only) need it. If you're picking up the RBAC/templates/AI-review/file-upload enhancements (see the section below), you'll also need two new env vars — copy them from `.env.example` into your `.env`:

- `ENCRYPTION_KEY` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Encrypts SMTP passwords and AI provider API keys at rest (`lib/crypto-secrets.ts`).
- `UPLOADS_DIR` — where per-engagement file uploads land on disk (default `./uploads`, gitignored).

```bash
npx drizzle-kit push           # prefer this over `npm run db:push` — shows prompts a non-interactive run can silently skip
psql "$DATABASE_URL" -f db/rls-policies.sql   # must be a superuser connection — see below
```

`db:push` only adds what's new (it won't touch your existing rows), and `rls-policies.sql` is idempotent (`CREATE OR REPLACE FUNCTION`, `CREATE POLICY` guarded by the policies being dropped/recreated on each run) — safe to re-run any time the schema or policies change. Restart `npm run dev` afterward.

**If a superadmin-only feature (permissions matrix, task templates, engagement types) suddenly starts 500ing after a pull**, the most likely cause is that the new tables never actually got created — `npx drizzle-kit push` run non-interactively can silently skip a prompt. Confirm with a one-off query (`SELECT 1 FROM permissions LIMIT 1;` etc.) and re-run `npx drizzle-kit push` interactively if it errors with "relation does not exist."

**Picking up the custom roles / workspace isolation / superadmin user management enhancement** (see the section below) needs the same two commands run again — it adds `custom_roles`, `client_members`, `project_custom_role_members`, `task_members`, `client_invitations`, `task_invitations`, a `custom_role_id` column on `project_invitations`, and several new `users` columns (`contact_number`, `business_name`, `business_address`, `must_reset_password`). No new env vars for this one.

**Picking up the permission-catalog rework** (aspect × View/Create/Edit/Delete grid, replacing the old ad-hoc `task.write`/`file.upload`/`project.manage_members`-style keys — see Custom roles below) also needs the same two commands re-run: `db/rls-policies.sql` deletes the old catalog keys and their `role_permissions` rows before inserting the new ones, and `db/schema.ts` widens `client_members`' unique index to `(client_id, user_id, custom_role_id)` so a user can hold more than one CLIENT-scoped custom role at once. If any custom role had grants set under the old keys, re-tick its boxes at `/admin/custom-roles` afterward — the old key rows are gone, not migrated forward, since the aspects don't map 1:1 (e.g. old `file.manage` covered both what's now `files.edit` and `files.delete`). No new env vars for this one either.

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

- `services/notifications.ts` sends real email once SMTP settings are configured at `/admin/permissions` → `/admin/smtp-settings`; until then it logs the invite link to the console instead.
- Beyond the seeded super admin, the fastest way to get a second test user is to sign up a second account in an incognito window and invite it to a project from the first account's UI (project page → collaborators modal).
- New runtime dependencies added for this pass: `nodemailer` (SMTP), `openai` + `@google/generative-ai` (AI review), `pdf-parse` + `mammoth` (document text extraction). Run `npm install` after pulling.

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

## Enhancements: theming, RBAC, templates, settings, file uploads, AI review

### Theme

Blue + gold, high contrast — CSS custom properties in `app/globals.css` (`--primary`, `--gold`, `--gold-foreground`, higher-contrast `--border`/`--muted-foreground` than shadcn's defaults), consumed via Tailwind's `hsl(var(--x))` pattern. `--gold`/`--gold-foreground` are new tokens added to `tailwind.config.ts`'s color palette alongside shadcn's existing set — used as an accent (header/sidebar border trim, active nav item, focus ring) rather than a wholesale color swap.

### RBAC — permissions matrix

A super-admin-only, tickbox-matrix permissions system, **fully wired** end to end rather than a display layer over unchanged hardcoded checks:

- `permissions` (`db/schema.ts`) — a fixed, developer-maintained catalog: `key`, `label`, `scope` (`WORKSPACE` or `PROJECT`), `description`. Not editable through the app, including by super admins, so the keys code references by name can't drift. PROJECT-scope keys are named `<aspect>.<action>` — one row per aspect (`tasks`, `comments`, `files`, `members`, `engagement`, `ai_review`) with whichever of `view`/`create`/`edit`/`delete` actually applies to it (e.g. `comments` has no `edit` — there's no "edit someone else's comment" feature; `engagement` has no `create` — making a brand-new engagement is the workspace-scope `project.create` permission, not something a role scoped to one already-existing engagement can do). See `services/permissions.ts`'s `getProjectPermissionCatalogByAspect` for the grouped shape.
- `role_permissions` — the actual tickbox grid: `(scope, role, permission_key) -> granted`. This is what a super admin edits at `/admin/permissions`, and also what a custom role's own grants live in (see Custom roles below).
- `services/permissions.ts` — `roleHasPermission`, `userHasWorkspacePermission`, `userHasProjectPermission`, `userCanPerformOnProject`/`userCanAccessProject` (the authoritative per-user checks — they OR together a user's built-in role, every PROJECT-scoped custom role they hold, and every CLIENT-scoped custom role they hold, so someone with several roles gets the union of what all of them grant), `getPermissionMatrix`/`setRolePermission` (superadmin-only writes) for the standalone matrix UI, `getProjectPermissionCatalogByAspect` (the grouped shape the custom-role dialog's tickbox grid renders). Grants are cached in memory for 15s and invalidated on any write, since nearly every authorization check across the app reads this table.
- **RLS enforces the same matrix independently** — `has_permission()`/`has_workspace_permission()`/`has_project_permission()`/`can_perform_on_project()` in `db/rls-policies.sql` read `role_permissions` directly (and, for `can_perform_on_project()`, loop over every custom role a user holds the same way the app layer does), so a route that forgot to call the TypeScript check still can't bypass it at the database layer.
- Every previously-hardcoded role check this pass touched — client create/manage, project create/manage, engagement edit/delete, workspace/project/task member management, task CRUD, comments, files, AI review — now consults the matrix on both sides (service layer + RLS) instead of a hardcoded `role === 'ADMIN'`-style check. A few things are deliberately kept as **structural bypasses outside the matrix** (not togglable): super-admin's platform-wide override, a workspace's `OWNER`/`ADMIN` oversight bypass on writes, the workspace owner can't be removed, and the various signup/invite-acceptance bootstrap branches (a user adding themselves as the first member of something they just created). Sending/revoking project invitations is also left as a structural check (`services/invitations.ts`), not matrix-governed — there's no catalog entry for it, on purpose, since RLS's own `project_invitations_insert` policy is intentionally looser than the in-app check for that action.
- UI: `/admin/permissions` — a tickbox grid, one tab for Workspace-scope roles and one for Project-scope roles, superadmin-only (redirects otherwise; the route also checks and returns 403). This is still where a super admin adjusts the *built-in* `PROJECT_ADMIN`/`EDITOR`/`VIEWER` grants; a custom role's grants are set inline where the role itself is created/edited instead — see Custom roles below.

### Task list templates & engagement types

Build once, apply many times — a super admin defines reusable task lists and links them to a named "engagement type"; anyone who already has task-creation rights on a project can apply one to populate its backlog.

- `task_templates` / `task_template_items` — a named list of tasks (title, description, priority) in order.
- `engagement_types` / `engagement_type_templates` — a many-to-many link from a named engagement type to one or more templates.
- `project_engagement_type` — informational: which engagement type (if any) a project was created from. Re-applying is always a separate, explicit action, never automatic.
- `services/task-templates.ts`, `services/engagement-types.ts` — CRUD, superadmin-only writes (RLS backs this up: `task_templates_write`/`engagement_types_write` require `is_super_admin()`), reads open to any authenticated user (the picker needs it).
- `services/apply-template.ts` — `applyTaskTemplate` / `applyEngagementType`, the actual "populate the backlog" action. Gated by the same bar as creating a single task by hand (`task.write`, matrix-governed) — **not** superadmin-only, per the product decision that template *building* is superadmin-only but template *use* is available to whoever can already create tasks.
- UI: `/admin/task-templates` and `/admin/engagement-types` (superadmin builders). `components/CreateProjectDialog.tsx` gained an engagement-type picker that populates the backlog right after creating the project. `components/ApplyTemplateDialog.tsx` (an "Apply template" button in the project header) lets it happen later, on an existing engagement, too.

### SMTP settings

`/admin/smtp-settings` (superadmin-only) — host, port, username, password, from address/name, TLS toggle. The password is encrypted at rest (`lib/crypto-secrets.ts`, AES-256-GCM) and the GET endpoint never returns it decrypted — only whether one is currently set. `services/notifications.ts` now actually sends invite email through whatever's configured (via `nodemailer`), falling back to a console-log of the invite link if nothing's set up yet (keeps local dev/testing working without a mail server).

### AI provider settings & "Review via AI"

`/admin/ai-provider-settings` (superadmin-only) — API keys for OpenAI and Google Gemini, plus a **free-text model field per provider** (not a hardcoded dropdown — e.g. `gpt-4o`, `gemini-1.5-pro` are just defaults; point it at whatever model string your account actually has access to, since model lineups change faster than this code does), and a default-provider toggle. Keys are encrypted at rest the same way as the SMTP password.

`services/ai-review.ts` extracts text from an uploaded document (`lib/document-text-extraction.ts` — PDF via `pdf-parse`, Word via `mammoth`, plain text/markdown directly; anything else is rejected with a clear error) and sends it to the configured provider with a prompt asking for a structured legal-document review: a plain-language summary, recommendations, and notable clauses/risks — worded for contracts, MOAs, and similar documents, and explicit that it isn't legal advice. Gated by the `ai_review.run` permission (matrix-governed, PROJECT scope).

### Per-engagement file uploads

Local disk, app-controlled volume (`UPLOADS_DIR`, default `./uploads`) — `lib/file-storage.ts` namespaces files by workspace/project and sanitizes filenames so a crafted upload name can't path-traverse out of its own project's folder. `project_files` (`db/schema.ts`) tracks `category` (`REFERENCE` or `AI_REVIEWED`), the uploader, and (once reviewed) the AI analysis. `services/project-files.ts` mirrors `project_files` RLS exactly: read follows plain project visibility, upload requires `file.upload` (matrix-governed) or workspace admin, delete requires being the uploader, `file.manage`, or workspace admin.

Inside a project, this shows up as two new views (see below): **References** (the shared library) and **AI Review** (upload a document, click "Review via AI", then optionally "Add to References" once you're happy with it — that's just a category flip from `AI_REVIEWED` to `REFERENCE`, not a copy).

### Collapsible sidebar for project views

`app/projects/[projectId]/project-shell.tsx` — now five views (Board, List, Gantt, References, AI Review), moved from a horizontal tab bar into a collapsible left sidebar (icon-only when collapsed) so the extra two views don't crowd a horizontal bar and the board/list/gantt content gets more width.

## Custom roles, workspace isolation & superadmin user management

A three-part enhancement layered on top of the RBAC matrix above, tightening who can see what by default and giving a super admin direct control over roles and accounts.

### Workspace isolation rework

Before this pass, any workspace member (`MEMBER`/`GUEST` role) could see every `PUBLIC_TO_WORKSPACE` client/project in their workspace automatically. That's gone: **plain workspace membership no longer implies visibility into anything.** The only paths to seeing a client, engagement, or task now are:

- being the workspace's `OWNER` or an `ADMIN` (`is_workspace_admin()` — unchanged, deliberately retained as an oversight bypass so the person who runs the workspace, or someone they've explicitly made an admin, always sees everything in it), or a super admin;
- an explicit grant: a `client_members` row (client-wide), a `project_members` row or `project_custom_role_members` row (one engagement), or a `task_members` row (one task only);
- having created the client/project yourself (visibility for your own work, even before anyone else grants you anything).

`PUBLIC_TO_WORKSPACE` project visibility still exists as a column (nothing was dropped) but no longer functions as a visibility grant — `can_access_project()`/`can_perform_on_project()` in `db/rls-policies.sql` (PART 2) no longer check it, and `components/CreateProjectDialog.tsx` no longer offers it as an option. `services/clients.ts` and `services/projects.ts` were reworked to match (`canAccessClient`/`canAccessProject` helpers replace the old "any workspace member sees it" shortcuts).

### Custom roles

A super admin can define named roles beyond the built-in `PROJECT_ADMIN`/`EDITOR`/`VIEWER` (`/admin/custom-roles`), each scoped either:

- **PROJECT** — granted on one engagement at a time (`project_custom_role_members`, an *additive* layer on top of a `project_members` row — it doesn't replace or require changing the built-in role column), or
- **CLIENT** — granted once (`client_members`) and applying across every engagement under that client at once.

A custom role's actual grants are **not** a separate simplified Full-Access/View/Edit/Delete preset system — they plug into the exact same `role_permissions` matrix the built-in roles use, keyed by the role's id instead of a fixed name. What changed from the original version of this feature: **creating (or editing) a role and setting its grants is now a single step**, not two. The `/admin/custom-roles` create/edit dialog inlines an aspect × View/Create/Edit/Delete tickbox grid (`services/permissions.ts`'s `getProjectPermissionCatalogByAspect`, one row per aspect — blank cells where no corresponding action exists, e.g. no "delete" on `ai_review`) right alongside the name/scope/description fields; submitting the form creates the role and writes every ticked grant in one call (`services/custom-roles.ts`'s `createCustomRole`/`updateCustomRole` accept an optional `grantedKeys` array and hand off to `syncCustomRoleGrants`, which fully replaces the role's grant set against the catalog in a single transaction). The standalone `/admin/permissions` matrix still exists and still shows every custom role as an extra column there too (in *italics*, with "(client-wide)" on CLIENT-scoped ones) — it's a second view onto the same `role_permissions` rows, not a separate system. RLS reads the same table via `has_client_permission()`/`has_project_custom_role_permission()` functions.

**A user can hold multiple roles at once, on the same client or engagement, and effective permissions are the union (OR) of everything every held role grants** — not just "the most recent grant wins." This was previously only true for `project_custom_role_members` (its unique constraint already allowed several rows per user per project); `client_members` was fixed to match (`(client_id, user_id, custom_role_id)` unique index, was `(client_id, user_id)`), and both the app layer (`services/permissions.ts`'s `userCanPerformOnProject`/`userCanAccessProject`, which loop over every custom-role and client-member row a user has and return true if *any* grants the key) and RLS's `can_perform_on_project()`/`can_access_project()` implement the same OR-across-roles semantics independently.

### Task-level ACL

Genuinely new, not just a filtered engagement view: `task_members` grants one person `VIEWER` or `EDITOR` on **exactly one task**, with zero visibility into the rest of that engagement's backlog. Deliberately simple (two levels, no matrix) since the ask was narrow one-task sharing. Reachable from the task detail panel's new "Share" button (`components/TaskCollaboratorsModal.tsx`).

### Invitations

Three parallel invitation flows now exist, all sharing the same sha256-token/7-day-expiry/replay-safe-acceptance shape as the original project invite flow:

- `services/invitations.ts` — engagement invites, optionally carrying a PROJECT-scoped `customRoleId` layered on at acceptance.
- `services/client-invitations.ts` — client-wide invites, carrying a required CLIENT-scoped `customRoleId`.
- `services/task-invitations.ts` — single-task invites, carrying a `VIEWER`/`EDITOR` role.

`app/api/invites/accept/route.ts`'s single accept endpoint tries all three lookups in turn (a raw token doesn't carry a marker for which table it belongs to) since the accept link is the same shape for all three.

### Superadmin "add user" facility

`/admin/users` — a super admin can create an account directly, with a **temporary password they type in themselves** (not auto-generated-and-emailed) shown back once for them to relay out-of-band; the account is flagged `must_reset_password` for future UI to act on. Required fields: full name, contact number, email, account-level role (User / Super admin — not a client/project custom role, which is assigned separately via an invite once the account exists). Optional: business name, business address. Every new account still gets its own PERSONAL workspace, same as self-serve signup — under the isolation model above, it simply starts with zero access to anyone else's clients/engagements until invited. `services/users-admin.ts`'s `createUserBySuperAdmin` deliberately does **not** touch `app.current_user_id` mid-transaction the way `auth/signup.ts` does (that would leak the new user's identity into the rest of the acting superadmin's request) — it doesn't need to, since `is_super_admin()` already shortcuts both bootstrap RLS checks the new workspace/membership rows need.

## Board/list view quick-add, Backlog ordering, and task checklists

Three small task-management fixes:

- **Add a task directly from the board.** Each Kanban column now has its own "Add task" quick-add form (`components/KanbanBoard.tsx`), matching the one List view already had — it posts straight into that column's status rather than always landing in Backlog. `createTask` (`services/tasks.ts`) and the `POST /api/projects/:projectId/tasks` route both gained an optional `status` field for this; List view's quick-add still omits it and gets the old BACKLOG default.
- **Backlog now sorts first in List view**, not last — just a reorder of the `GROUPS` array in `components/TaskListView.tsx`.
- **Task checklists** — a lightweight punch-list inside a task (checkbox + short title + optional free-text remarks), separate from the existing "Subtasks" section (which links real child tasks with their own status/assignee). New `task_checklist_items` table (`db/schema.ts`); RLS mirrors `task_comments`' visibility (task-level access via a `task_members` grant or project `tasks.view`) but gates every write — add, toggle-complete, edit, delete — by a single `tasks.edit` check, the same bar as editing the task's own title or description, since there's no meaningful create/toggle/delete split here. `services/task-checklist.ts` (list/add/update/delete) and `app/api/projects/[projectId]/tasks/[taskId]/checklist/**` wire it up; `components/TaskDetailPanel.tsx` renders it as its own "Checklist" section with a completed-count badge, inline add form, and per-item checkbox/delete.

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
- `services/task-checklist.ts` — list/add/update (toggle-complete or edit)/delete checklist items, gated by `tasks.edit`.
- `services/dashboard.ts` — `getWorkspaceDashboard`, the landing page's single aggregate query.
- `services/invitations.ts` — `sendProjectInvite`, `acceptProjectInvite`, `revokeProjectInvite`.
- `services/workspace-members.ts` — `removeWorkspaceMember`, with task-reassignment handling.
- `services/notifications.ts` — email/in-app adapters; email now goes through `services/smtp-settings.ts`'s configured server via `nodemailer`.
- `services/permissions.ts` — the RBAC matrix: `userHasWorkspacePermission`/`userHasProjectPermission`, `userCanPerformOnProject`/`userCanAccessProject` (the multi-role-aware checks most services call), `getPermissionMatrix`/`setRolePermission`, `getProjectPermissionCatalogByAspect` (feeds the custom-role dialog's tickbox grid).
- `services/task-templates.ts`, `services/engagement-types.ts`, `services/apply-template.ts` — template/engagement-type CRUD and the backlog-population action.
- `services/smtp-settings.ts`, `services/ai-provider-settings.ts` — superadmin-managed platform settings; secrets encrypted via `lib/crypto-secrets.ts`.
- `services/project-files.ts` — per-engagement file upload/list/download/delete, local-disk storage via `lib/file-storage.ts`.
- `services/ai-review.ts` — the "Review via AI" action; text extraction via `lib/document-text-extraction.ts`, provider calls via `openai`/`@google/generative-ai`.
- `services/custom-roles.ts` — CRUD for named PROJECT/CLIENT-scoped roles (superadmin-only writes), plus `syncCustomRoleGrants` (full-replace a role's `role_permissions` grants against the catalog, used by both create and edit) and `getCustomRoleWithGrants` (role + its currently-granted keys, for pre-checking the edit dialog's tickboxes); deleting a role also clears its `role_permissions` rows.
- `services/client-members.ts`, `services/project-custom-role-members.ts`, `services/task-members.ts` — direct (non-invite) grant/revoke for client-wide, engagement-level-custom-role, and single-task access respectively.
- `services/client-invitations.ts`, `services/task-invitations.ts` — by-email invite flows mirroring `services/invitations.ts`'s token/expiry/acceptance shape, for client-wide and single-task access.
- `services/users-admin.ts` — `createUserBySuperAdmin`, `listAllUsers`, `setUserSuperAdminRole` — the superadmin "add user" facility.
- `scripts/seed-superadmin.ts` — creates/promotes the super admin account from `.env`.
- `app/api/**/route.ts` — Next.js route handlers wiring the above into HTTP, including `app/api/admin/**` (permissions, permission-catalog, task templates, engagement types, SMTP/AI settings, custom roles, users — all superadmin-gated), `app/api/projects/[projectId]/files/**` (uploads, download, delete, promote, AI review), `app/api/projects/[projectId]/custom-role-members/**` and `.../tasks/[taskId]/members|invitations/**`, and `app/api/clients/[clientId]/members|invitations/**`.
- `app/dashboard-shell.tsx` — the post-login landing page: stats, my tasks, upcoming deadlines, recent activity, clients/engagements roster, and a superadmin-only "Admin" menu (permissions matrix, custom roles, users, task templates, engagement types, SMTP settings, AI provider settings).
- `app/admin/**` — superadmin-only pages: permissions matrix, custom roles, users, task template builder, engagement type builder, SMTP settings, AI provider settings.
- `app/projects/[projectId]/` — project detail page and the collapsible-sidebar view shell (Board/List/Gantt/References/AI Review).
- `app/clients/[clientId]/` — client detail page (contact info, notes, engagements, collaborators).
- `lib/format-activity.ts` — turns an activity-log row into a human sentence for the recent-activity feed.
- `lib/crypto-secrets.ts` — AES-256-GCM encrypt/decrypt for secrets at rest (`ENCRYPTION_KEY`).
- `lib/file-storage.ts` — local-disk file storage helpers (`UPLOADS_DIR`).
- `lib/document-text-extraction.ts` — PDF/Word/text extraction for the AI review flow.
- `components/*.tsx` — WorkspaceSelector, ProjectCollaboratorModal, ClientCollaboratorsModal, TaskCollaboratorsModal, KanbanBoard, TaskListView, GanttChart, TaskDetailPanel, CreateProjectDialog, CreateClientDialog, ApplyTemplateDialog, ReferencesTab, AiReviewTab, plus the shadcn/ui primitives under `components/ui/`.
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
