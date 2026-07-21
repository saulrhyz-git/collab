# Architecture Overview & Security Notes

Stack: Next.js 14 App Router (API + frontend), Drizzle ORM over PostgreSQL with Row-Level Security, NextAuth v5 (JWT sessions), Socket.io for realtime. Files referenced below live in this same directory tree.

## File map

- `db/schema.ts` — Drizzle schema, all eight tables, enums, indexes, relations.
- `db/rls-policies.sql` — RLS enablement + policies, run after the Drizzle migration.
- `db/with-rls-context.ts`, `db/client.ts` — the transaction wrapper that sets the `app.current_user_id` / `app.current_workspace_id` session GUCs every policy reads.
- `auth/signup.ts` — signup + automatic personal workspace provisioning.
- `auth/auth.config.ts`, `auth/index.ts` — NextAuth v5 credentials provider, JWT callbacks.
- `auth/workspace-context.middleware.ts` — resolves and **verifies** the active workspace on every request.
- `services/invitations.ts` — `sendProjectInvite`, `acceptProjectInvite`, `revokeProjectInvite`.
- `services/workspace-members.ts` — `removeWorkspaceMember`, with task-reassignment handling.
- `services/notifications.ts` — email/in-app adapters.
- `app/api/**/route.ts` — Next.js route handlers wiring the above into HTTP.
- `components/*.tsx` — WorkspaceSelector, ProjectCollaboratorModal, KanbanBoard.
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
