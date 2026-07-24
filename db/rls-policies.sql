-- ============================================================================
-- Row-Level Security policies + supplementary constraints
-- Run AFTER the Drizzle-generated migration that creates the base tables.
--
-- Strategy: every request sets two session-local GUCs at the top of its
-- transaction (via runWithRlsContext() in db/client.ts, wired into
-- auth/require-user.ts and auth/workspace-context.middleware.ts):
--
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_workspace_id = '<uuid>';   -- the ACTIVE workspace (currently unused by any policy below — reserved)
--
-- Policies then filter every row against these GUCs. Because they're
-- SET LOCAL, they're transaction-scoped and can never leak across pooled
-- connections between requests. A missing/blank GUC evaluates to '' which
-- matches nothing, so a bug that forgets to set the context fails closed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: partial unique index — one PERSONAL workspace per owner
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_personal_per_owner_idx
  ON workspaces (owner_id)
  WHERE type = 'PERSONAL';

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_app_workspace_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Platform-wide super admin bypass. Deliberately baked directly into
-- is_workspace_member() / is_workspace_admin() / is_project_member() below
-- rather than OR'd into every individual policy — those three predicates
-- are what nearly every other policy composes from (directly or via
-- can_access_project()), so patching them here cascades correctly almost
-- everywhere a super admin needs access, with only a couple of policies
-- (workspaces_delete, the invite-acceptance bootstrap checks) needing an
-- explicit mention because they don't go through any of the three.
CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT u.is_super_admin FROM users u WHERE u.id = current_app_user_id()),
    false
  );
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Recursive-RLS bypass role.
--
-- is_workspace_member() / is_workspace_admin() / is_project_member() below
-- each query workspace_members or project_members — but those two tables
-- have FORCE ROW LEVEL SECURITY, and their OWN select/write policies call
-- these same functions. Left as plain (SECURITY INVOKER) functions, calling
-- is_workspace_member() triggers workspace_members' SELECT policy, which
-- calls is_workspace_member() again to filter the very rows the function
-- is trying to read, which calls it again, forever — Postgres eventually
-- aborts with "stack depth limit exceeded" rather than looping forever.
-- This isn't hypothetical: it fires for any ordinary (non-super-admin)
-- request, since is_super_admin()'s short-circuit is the only thing that
-- was ever skipping the recursive branch during earlier testing.
--
-- The fix (the standard Postgres pattern for "a table's policy needs to
-- query that same table"): make the three functions SECURITY DEFINER and
-- own them by a dedicated role with the BYPASSRLS attribute. Executing as
-- that role, their internal SELECTs skip row security entirely instead of
-- re-triggering the policy that's calling them. The role itself can't log
-- in and has no privileges beyond BYPASSRLS — it exists purely to break
-- this recursion, not to widen access (the functions still filter by
-- current_app_user_id() exactly as before; only the recursion is removed).
--
-- CREATE ROLE ... BYPASSRLS can only be run by a superuser. If this block
-- errors with "permission denied", re-run just this DO block (and the
-- ALTER FUNCTION ... OWNER TO lines below) via a superuser connection —
-- e.g. `psql -U postgres -d <your_db>` — then re-run the rest of this file
-- as usual. See README.md's "Apply Row-Level Security" step.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_helper') THEN
    CREATE ROLE rls_helper NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- BYPASSRLS only skips row-security filtering — it does NOT imply the usual
-- table-level privilege grants a normal SELECT needs. Without this, every
-- SECURITY DEFINER function below fails with "permission denied for table
-- ..." the moment it runs, since rls_helper otherwise has zero privileges
-- on these tables (only their owner and superusers get that implicitly).
GRANT SELECT ON workspaces, workspace_members, projects, project_members, project_invitations, users, role_permissions
  TO rls_helper;

-- Is the current user a member of the given workspace (any role)?
CREATE OR REPLACE FUNCTION is_workspace_member(ws_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id AND wm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_workspace_member(uuid) OWNER TO rls_helper;

-- Is the current user OWNER/ADMIN of the given workspace?
CREATE OR REPLACE FUNCTION is_workspace_admin(ws_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id
      AND wm.user_id = current_app_user_id()
      AND wm.role IN ('OWNER', 'ADMIN')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_workspace_admin(uuid) OWNER TO rls_helper;

-- Is the current user a direct member of the given project (project-scoped
-- guest access included) regardless of workspace-level membership?
CREATE OR REPLACE FUNCTION is_project_member(p_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = p_id AND pm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_project_member(uuid) OWNER TO rls_helper;

-- Can the current user see this project at all? Either:
--  (a) workspace member AND project is PUBLIC_TO_WORKSPACE, or
--  (b) explicit row in project_members (covers PRIVATE_TO_MEMBERS and
--      project-scoped guests who are NOT full workspace members)
CREATE OR REPLACE FUNCTION can_access_project(p_id uuid, ws_id uuid, visibility project_visibility) RETURNS boolean AS $$
  SELECT
    (visibility = 'PUBLIC_TO_WORKSPACE' AND is_workspace_member(ws_id))
    OR is_project_member(p_id);
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- More bypass helpers, same reasoning as above but for a subtler variant of
-- the same problem. Several *other* tables' policies need to check a fact
-- about workspaces/projects/project_invitations that does NOT match that
-- table's own SELECT policy (e.g. "is this the workspace's owner" vs.
-- "is_workspace_member"; "is this project's creator" vs. "can_access_project").
-- Written as a plain (non-bypass) subquery, that mismatch means the row is
-- invisible to the very check that's supposed to read it — not infinite
-- recursion this time, just a silent false, which surfaces as "new row
-- violates row-level security policy" on what should be a routine bootstrap
-- insert (a brand-new workspace owner adding their own OWNER row; a project
-- creator adding their own PROJECT_ADMIN row; an invitee accepting an invite
-- that predates their account). Same fix: SECURITY DEFINER + rls_helper.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_workspace_owner(ws_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ws_id AND w.owner_id = current_app_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_workspace_owner(uuid) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION project_workspace_id(p_id uuid) RETURNS uuid AS $$
  SELECT workspace_id FROM projects WHERE id = p_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION project_workspace_id(uuid) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION is_project_creator(p_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM projects p WHERE p.id = p_id AND p.created_by = current_app_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_project_creator(uuid) OWNER TO rls_helper;

-- Pending invite lookups bypass project_invitations for the same reason —
-- an invite addressed to an email that predates the invitee's account has
-- invitee_user_id still NULL, so project_invitations_select's own policy
-- (inviter/invitee/workspace-admin) doesn't yet match the accepting user,
-- even though this is exactly the row their acceptance bootstrap needs to see.
CREATE OR REPLACE FUNCTION has_pending_workspace_invite(ws_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_invitations pi
    WHERE pi.workspace_id = ws_id
      AND pi.status = 'PENDING'
      AND (
        pi.invitee_user_id = current_app_user_id()
        OR pi.invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_pending_workspace_invite(uuid) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION has_pending_project_invite(p_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_invitations pi
    WHERE pi.project_id = p_id
      AND pi.status = 'PENDING'
      AND (
        pi.invitee_user_id = current_app_user_id()
        OR pi.invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_pending_project_invite(uuid) OWNER TO rls_helper;

-- ---------------------------------------------------------------------------
-- RBAC permissions matrix helpers.
--
-- has_permission() is the raw lookup against role_permissions — safe as a
-- plain (non-bypass) function since that table isn't self-referential
-- (doesn't touch workspace_members/project_members), so no recursion risk.
-- has_workspace_permission()/has_project_permission() layer the actual
-- membership lookup on top and DO need the bypass treatment, for the same
-- reason is_workspace_admin()/is_project_member() do above.
--
-- can_perform_on_project() generalizes can_access_project(): a workspace
-- member with no explicit project_members row on a PUBLIC_TO_WORKSPACE
-- project is treated as VIEWER-equivalent for permission purposes (matching
-- can_access_project's existing visibility rule), so the matrix's VIEWER
-- grant governs what they can do there too, rather than an unconditional
-- allow. Used anywhere a *specific* permission key gates an action on task/
-- comment/file rows that hang off a project, as opposed to plain visibility.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION has_permission(p_scope text, p_role text, p_key text) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT rp.granted FROM role_permissions rp
     WHERE rp.scope::text = p_scope AND rp.role = p_role AND rp.permission_key = p_key),
    false
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION has_workspace_permission(ws_id uuid, p_key text) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id
      AND wm.user_id = current_app_user_id()
      AND has_permission('WORKSPACE', wm.role::text, p_key)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_workspace_permission(uuid, text) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION has_project_permission(p_id uuid, p_key text) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = p_id
      AND pm.user_id = current_app_user_id()
      AND has_permission('PROJECT', pm.role::text, p_key)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_project_permission(uuid, text) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION can_perform_on_project(p_id uuid, ws_id uuid, visibility project_visibility, p_key text) RETURNS boolean AS $$
  SELECT
    (visibility = 'PUBLIC_TO_WORKSPACE' AND is_workspace_member(ws_id) AND has_permission('PROJECT', 'VIEWER', p_key))
    OR has_project_permission(p_id, p_key);
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY; -- applies even to the table owner role

DROP POLICY IF EXISTS workspaces_select ON workspaces;
CREATE POLICY workspaces_select ON workspaces
  FOR SELECT USING (is_workspace_member(id));

DROP POLICY IF EXISTS workspaces_update ON workspaces;
CREATE POLICY workspaces_update ON workspaces
  FOR UPDATE USING (is_workspace_admin(id));

DROP POLICY IF EXISTS workspaces_delete ON workspaces;
CREATE POLICY workspaces_delete ON workspaces
  FOR DELETE USING (owner_id = current_app_user_id() OR is_super_admin());

-- A workspace can only be inserted by the user who will own it (checked
-- against current_app_user_id(), not the client-supplied owner_id — see
-- auth/signup.ts and services/workspaces.ts, both of which set the RLS
-- session to the owner's own id before this insert runs).
DROP POLICY IF EXISTS workspaces_insert ON workspaces;
CREATE POLICY workspaces_insert ON workspaces
  FOR INSERT WITH CHECK (owner_id = current_app_user_id() OR is_super_admin());

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_members_select ON workspace_members;
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT USING (is_workspace_member(workspace_id));

DROP POLICY IF EXISTS workspace_members_insert ON workspace_members;
CREATE POLICY workspace_members_insert ON workspace_members
  FOR INSERT WITH CHECK (
    is_workspace_admin(workspace_id)
    -- Bootstrap: the workspace's own owner may insert their first (OWNER)
    -- membership row — without this, nobody could ever become the first
    -- admin of a workspace they just created, since is_workspace_admin()
    -- requires an existing membership row to already exist. is_workspace_owner()
    -- bypasses workspaces' own SELECT policy (which itself needs this very
    -- membership row) — see the comment above that function.
    OR (
      role = 'OWNER'
      AND user_id = current_app_user_id()
      AND is_workspace_owner(workspace_id)
    )
    -- Invite acceptance: a user may insert themselves as GUEST when
    -- there's a matching pending invitation addressed to them (by id or,
    -- for invites sent before they had an account, by email) — mirrors
    -- the email-match check acceptProjectInvite already performs in
    -- services/invitations.ts before running this insert. Goes through
    -- has_pending_workspace_invite() rather than a raw subquery for the
    -- same reason: a brand-new invitee can't yet see project_invitations
    -- via its own SELECT policy.
    OR (
      role = 'GUEST'
      AND user_id = current_app_user_id()
      AND has_pending_workspace_invite(workspace_id)
    )
  );

DROP POLICY IF EXISTS workspace_members_update ON workspace_members;
CREATE POLICY workspace_members_update ON workspace_members
  FOR UPDATE USING (is_workspace_admin(workspace_id) OR has_workspace_permission(workspace_id, 'workspace.manage_members'));

DROP POLICY IF EXISTS workspace_members_delete ON workspace_members;
CREATE POLICY workspace_members_delete ON workspace_members
  FOR DELETE USING (
    is_workspace_admin(workspace_id)
    OR has_workspace_permission(workspace_id, 'workspace.manage_members')
    OR user_id = current_app_user_id() -- self-removal ("leave workspace")
  );

-- ---------------------------------------------------------------------------
-- clients — a workspace's roster of external parties. No separate
-- "client_members" concept: visibility follows plain workspace membership
-- (unlike projects, clients have no per-row privacy setting — a client
-- record is metadata about who you work with, not itself sensitive project
-- content), and any workspace member can create one, same latitude as
-- projects_insert. Editing is restricted to whoever created the record or a
-- workspace admin, so one team member can't silently rewrite another's
-- client notes/contact info.
-- ---------------------------------------------------------------------------
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clients_select ON clients;
CREATE POLICY clients_select ON clients
  FOR SELECT USING (is_workspace_member(workspace_id));

-- client.create / client.manage are matrix-governed (see role_permissions);
-- workspace admin and self-created-it stay as structural bypasses on top.
DROP POLICY IF EXISTS clients_insert ON clients;
CREATE POLICY clients_insert ON clients
  FOR INSERT WITH CHECK (has_workspace_permission(workspace_id, 'client.create') AND created_by = current_app_user_id());

DROP POLICY IF EXISTS clients_update ON clients;
CREATE POLICY clients_update ON clients
  FOR UPDATE USING (
    is_workspace_admin(workspace_id)
    OR created_by = current_app_user_id()
    OR has_workspace_permission(workspace_id, 'client.manage')
  );

DROP POLICY IF EXISTS clients_delete ON clients;
CREATE POLICY clients_delete ON clients
  FOR DELETE USING (is_workspace_admin(workspace_id) OR has_workspace_permission(workspace_id, 'client.manage'));

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_select ON projects;
CREATE POLICY projects_select ON projects
  FOR SELECT USING (can_access_project(id, workspace_id, visibility));

DROP POLICY IF EXISTS projects_insert ON projects;
CREATE POLICY projects_insert ON projects
  FOR INSERT WITH CHECK (has_workspace_permission(workspace_id, 'project.create'));

DROP POLICY IF EXISTS projects_update ON projects;
CREATE POLICY projects_update ON projects
  FOR UPDATE USING (
    is_workspace_admin(workspace_id)
    OR has_workspace_permission(workspace_id, 'project.manage')
    OR has_project_permission(id, 'engagement.edit')
  );

DROP POLICY IF EXISTS projects_delete ON projects;
CREATE POLICY projects_delete ON projects
  FOR DELETE USING (
    is_workspace_admin(workspace_id)
    OR has_workspace_permission(workspace_id, 'project.manage')
    -- A PROJECT_ADMIN (or custom role holding engagement.delete) can now
    -- archive the one engagement they administer, without needing the
    -- broader workspace-level project.manage permission — a gap in the
    -- original design (only workspace admin/permission could ever archive
    -- a project, even one you were PROJECT_ADMIN on).
    OR has_project_permission(id, 'engagement.delete')
  );

-- ---------------------------------------------------------------------------
-- project_members
-- ---------------------------------------------------------------------------
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members FORCE ROW LEVEL SECURITY;

-- The three policies below check "is_workspace_admin(this project's
-- workspace)" via project_workspace_id() rather than a raw
-- `EXISTS (SELECT ... FROM projects p WHERE ...)`, because a plain subquery
-- on `projects` here would be filtered by projects_select's own policy
-- (can_access_project) — a DIFFERENT, stricter condition than
-- "is_workspace_admin" — so a workspace admin who isn't yet a project
-- member of a private project would silently fail this check even though
-- the intent is clearly to let them through.
DROP POLICY IF EXISTS project_members_select ON project_members;
CREATE POLICY project_members_select ON project_members
  FOR SELECT USING (
    is_workspace_admin(project_workspace_id(project_id))
    OR user_id = current_app_user_id() -- always see your own membership row
    OR can_perform_on_project(
      project_id, project_workspace_id(project_id),
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'members.view'
    )
  );

DROP POLICY IF EXISTS project_members_insert ON project_members;
CREATE POLICY project_members_insert ON project_members
  FOR INSERT WITH CHECK (
    is_workspace_admin(project_workspace_id(project_id))
    -- Matrix-governed: whoever holds 'members.create' (PROJECT_ADMIN by
    -- default) can add members — replaces the old hardcoded role check.
    OR has_project_permission(project_id, 'members.create')
    -- Bootstrap: the project's own creator may insert their first
    -- (PROJECT_ADMIN) membership row immediately after creating it — same
    -- shape as workspace_members_insert's OWNER bootstrap branch, and
    -- necessary for the same reason: an ordinary workspace member (not
    -- necessarily a workspace admin) creating their own project has no
    -- other branch that would let this first membership row through.
    OR (
      role = 'PROJECT_ADMIN'
      AND user_id = current_app_user_id()
      AND is_project_creator(project_id)
    )
    -- Invite acceptance bootstrap — same shape as workspace_members_insert
    -- above: a user may insert themselves when a matching pending invite
    -- exists, since they're not yet a project member (that's the whole
    -- point of accepting) and so can't satisfy either branch above.
    -- has_pending_project_invite() bypasses project_invitations' own
    -- SELECT policy for the same reason is_workspace_owner() does above.
    OR (
      user_id = current_app_user_id()
      AND has_pending_project_invite(project_id)
    )
  );

DROP POLICY IF EXISTS project_members_delete ON project_members;
CREATE POLICY project_members_delete ON project_members
  FOR DELETE USING (
    user_id = current_app_user_id() -- self-removal
    OR is_workspace_admin(project_workspace_id(project_id))
    OR has_project_permission(project_id, 'members.delete')
  );

-- Fixes a pre-existing gap: there was never an UPDATE policy on
-- project_members at all, so services/project-members.ts's
-- updateProjectMemberRole (changing someone's role) would have failed
-- under FORCE ROW LEVEL SECURITY's default-deny — masked because it was
-- never exercised by an ordinary (non-superadmin) account in prior testing.
DROP POLICY IF EXISTS project_members_update ON project_members;
CREATE POLICY project_members_update ON project_members
  FOR UPDATE USING (
    is_workspace_admin(project_workspace_id(project_id))
    OR has_project_permission(project_id, 'members.edit')
  );

-- ---------------------------------------------------------------------------
-- project_invitations
-- ---------------------------------------------------------------------------
ALTER TABLE project_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_invitations_select ON project_invitations;
CREATE POLICY project_invitations_select ON project_invitations
  FOR SELECT USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id()
    OR is_workspace_admin(workspace_id)
  );

DROP POLICY IF EXISTS project_invitations_insert ON project_invitations;
CREATE POLICY project_invitations_insert ON project_invitations
  FOR INSERT WITH CHECK (
    inviter_id = current_app_user_id()
    AND (is_workspace_admin(workspace_id) OR is_project_member(project_id))
  );

DROP POLICY IF EXISTS project_invitations_update ON project_invitations;
CREATE POLICY project_invitations_update ON project_invitations
  FOR UPDATE USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id() -- accept/decline
    -- Covers invites sent to an email before that person had an account:
    -- invitee_user_id is NULL until acceptance links it, so email is the
    -- only thing to match on for the very update that sets it.
    OR invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
    OR is_workspace_admin(workspace_id)
  );

-- ---------------------------------------------------------------------------
-- tasks
--
-- NOTE: tasks_select/tasks_write (defined here using the pre-aspect-model
-- 'task.write'/'task.comment' keys) are superseded further down, in PART 2,
-- by tasks_select/tasks_insert/tasks_update/tasks_delete and
-- task_comments_select/insert/delete using the current tasks.*/comments.*
-- keys — PART 2 runs later in this same script, so its versions are what
-- actually ends up live. Left here (rather than deleted) so ALTER TABLE ...
-- ENABLE ROW LEVEL SECURITY always has at least one policy in place for the
-- brief window between this file starting and PART 2 finishing, on a
-- from-scratch run.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id AND can_access_project(p.id, p.workspace_id, p.visibility)
    )
  );

DROP POLICY IF EXISTS tasks_write ON tasks;
CREATE POLICY tasks_write ON tasks
  FOR ALL USING (
    is_workspace_admin(workspace_id)
    OR can_perform_on_project(
      project_id,
      workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'task.write'
    )
  );

-- ---------------------------------------------------------------------------
-- task_dependencies — Gantt blocking relationships. Visibility/write rights
-- are inherited from the successor task's project (arbitrary but
-- consistent choice — a dependency is meaningless without both ends
-- existing in the same project, which the app layer enforces on insert).
-- ---------------------------------------------------------------------------
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependencies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_dependencies_select ON task_dependencies;
CREATE POLICY task_dependencies_select ON task_dependencies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = successor_task_id AND can_access_project(p.id, p.workspace_id, p.visibility)
    )
  );

DROP POLICY IF EXISTS task_dependencies_write ON task_dependencies;
CREATE POLICY task_dependencies_write ON task_dependencies
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = successor_task_id
        AND (is_workspace_admin(t.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'task.write'))
    )
  );

-- ---------------------------------------------------------------------------
-- task_comments — anyone who can see the task can read comments; anyone who
-- can see the task can post one (commenting is lower-privilege than editing
-- the task itself — VIEWER-role project members can weigh in even though
-- they can't move or edit the task, same as Asana/Linear).
-- ---------------------------------------------------------------------------
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_comments_select ON task_comments;
CREATE POLICY task_comments_select ON task_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = task_id AND can_access_project(p.id, p.workspace_id, p.visibility)
    )
  );

DROP POLICY IF EXISTS task_comments_insert ON task_comments;
CREATE POLICY task_comments_insert ON task_comments
  FOR INSERT WITH CHECK (
    author_id = current_app_user_id()
    AND EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = task_id AND can_perform_on_project(p.id, p.workspace_id, p.visibility, 'task.comment')
    )
  );

DROP POLICY IF EXISTS task_comments_delete ON task_comments;
CREATE POLICY task_comments_delete ON task_comments
  FOR DELETE USING (
    author_id = current_app_user_id()
    OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND is_workspace_admin(t.workspace_id))
  );

-- ---------------------------------------------------------------------------
-- activity_logs — append-only, readable by anyone who can see the project/workspace
-- ---------------------------------------------------------------------------
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activity_logs_select ON activity_logs;
CREATE POLICY activity_logs_select ON activity_logs
  FOR SELECT USING (is_workspace_member(workspace_id));

DROP POLICY IF EXISTS activity_logs_insert ON activity_logs;
CREATE POLICY activity_logs_insert ON activity_logs
  FOR INSERT WITH CHECK (is_workspace_member(workspace_id));

-- No UPDATE/DELETE policy is created for activity_logs -> table is
-- effectively immutable to the application role (audit integrity).

-- ---------------------------------------------------------------------------
-- permissions / role_permissions — the RBAC matrix. `permissions` is a fixed
-- catalog (seeded below, not user-editable); `role_permissions` is the
-- actual tickbox grid, editable only by a super admin. Both are readable by
-- any authenticated user because ordinary requests (via has_permission() and
-- friends above) need to read grants to authorize themselves — restricting
-- SELECT to super admins would break every permission check for everyone else.
-- ---------------------------------------------------------------------------
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS permissions_select ON permissions;
CREATE POLICY permissions_select ON permissions
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

-- No insert/update/delete policy — the catalog is developer-maintained via
-- the seed block below, not editable through the app at all (including by
-- super admins), so its keys can't drift out from under the code that
-- references them by name.

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_select ON role_permissions;
CREATE POLICY role_permissions_select ON role_permissions
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS role_permissions_write ON role_permissions;
CREATE POLICY role_permissions_write ON role_permissions
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

-- Permission catalog. ON CONFLICT DO NOTHING keeps this re-runnable without
-- clobbering rows a future migration might add columns to.
--
-- The PROJECT-scope rows below are named `<aspect>.<action>` — a clean
-- aspect x action grid (Tasks/Comments/Files/Members/Engagement/AI Review,
-- each with whichever of View/Create/Edit/Delete genuinely applies) rather
-- than the earlier ad-hoc key-per-feature list (task.write, file.manage,
-- etc.). This is what both the /admin/permissions matrix and a custom
-- role's inline tickbox grid (/admin/custom-roles) render — the same keys
-- are reused for CLIENT-scoped custom roles too (see role_permissions rows
-- with scope='CLIENT' below), applying the same grants across every one of
-- a client's engagements at once instead of just one.
--
-- Some cells are deliberately omitted rather than included-but-meaningless:
-- Comments has no Edit (nothing lets anyone edit someone else's comment;
-- editing your own is never permission-gated), Engagement has no Create
-- (creating a NEW engagement is the workspace-scope project.create, above —
-- a role scoped to one already-existing engagement can't "create" it), and
-- AI Review has only View/Create (there's no edit/delete-a-review action).
--
-- The DELETE below removes the old ad-hoc keys this replaces — plain
-- ON CONFLICT DO NOTHING would leave them behind as orphaned rows nothing
-- reads anymore.
DELETE FROM role_permissions WHERE permission_key IN (
  'task.write', 'task.comment', 'project.edit', 'project.manage_members', 'file.upload', 'file.manage', 'ai_review.run'
);
DELETE FROM permissions WHERE key IN (
  'task.write', 'task.comment', 'project.edit', 'project.manage_members', 'file.upload', 'file.manage', 'ai_review.run'
);

INSERT INTO permissions (key, label, scope, description) VALUES
  ('client.create', 'Create clients', 'WORKSPACE', 'Add a new client to the workspace.'),
  ('client.manage', 'Manage any client', 'WORKSPACE', 'Edit or archive clients you did not create yourself.'),
  ('project.create', 'Create engagements', 'WORKSPACE', 'Create a new project/engagement in the workspace.'),
  ('project.manage', 'Manage any engagement', 'WORKSPACE', 'Edit, archive, or delete any project in the workspace, regardless of project-level membership.'),
  ('workspace.manage_members', 'Manage workspace members', 'WORKSPACE', 'Invite, remove, or change the role of workspace members.'),

  ('tasks.view',   'View tasks',   'PROJECT', 'See this engagement''s tasks and their details.'),
  ('tasks.create', 'Create tasks', 'PROJECT', 'Add new tasks, including via applying a task template.'),
  ('tasks.edit',   'Edit tasks',   'PROJECT', 'Edit, move, reassign tasks, and manage their dependencies.'),
  ('tasks.delete', 'Delete tasks', 'PROJECT', 'Delete tasks from this engagement.'),

  ('comments.view',   'View comments',       'PROJECT', 'See comments posted on tasks.'),
  ('comments.create', 'Post comments',       'PROJECT', 'Comment on tasks.'),
  ('comments.delete', 'Delete any comment',  'PROJECT', 'Delete comments posted by other people (you can always delete your own).'),

  ('files.view',   'View files',   'PROJECT', 'See the References tab and uploaded files.'),
  ('files.create', 'Upload files', 'PROJECT', 'Upload new files, to References or for AI review.'),
  ('files.edit',   'Edit files',   'PROJECT', 'Recategorize a file, e.g. promote an AI-reviewed document to References.'),
  ('files.delete', 'Delete files', 'PROJECT', 'Delete files uploaded by other people (you can always delete your own).'),

  ('members.view',   'View collaborators',            'PROJECT', 'See this engagement''s member roster.'),
  ('members.create', 'Add collaborators',              'PROJECT', 'Invite or add people to this engagement.'),
  ('members.edit',   'Change collaborator roles',       'PROJECT', 'Change an existing collaborator''s role.'),
  ('members.delete', 'Remove collaborators',            'PROJECT', 'Remove people from this engagement.'),

  ('engagement.view',   'View engagement details', 'PROJECT', 'See this engagement''s name, description, and settings.'),
  ('engagement.edit',   'Edit engagement details', 'PROJECT', 'Edit this engagement''s name, description, visibility, and client.'),
  ('engagement.delete', 'Delete engagement',       'PROJECT', 'Archive this engagement.'),

  ('ai_review.view',   'View AI reviews', 'PROJECT', 'See past AI review summaries.'),
  ('ai_review.create', 'Run AI review',   'PROJECT', 'Submit a document for AI-assisted review.')
ON CONFLICT (key) DO NOTHING;

-- Default grants for the built-in roles — chosen to reproduce what the
-- old, single-flag-per-feature keys granted (PROJECT_ADMIN/EDITOR both held
-- task.write/file.upload/ai_review.run; only PROJECT_ADMIN held
-- project.edit/project.manage_members/file.manage), so installing this
-- rework changes nothing for the built-ins until a super admin edits a
-- tickbox. View-type keys default true for every role since visibility was
-- previously ungated by the matrix at all (any project member could see
-- tasks/comments/files/the roster/engagement details regardless of role).
INSERT INTO role_permissions (scope, role, permission_key, granted) VALUES
  ('WORKSPACE', 'OWNER',  'client.create', true),
  ('WORKSPACE', 'ADMIN',  'client.create', true),
  ('WORKSPACE', 'MEMBER', 'client.create', true),
  ('WORKSPACE', 'GUEST',  'client.create', false),
  ('WORKSPACE', 'OWNER',  'client.manage', true),
  ('WORKSPACE', 'ADMIN',  'client.manage', true),
  ('WORKSPACE', 'MEMBER', 'client.manage', false),
  ('WORKSPACE', 'GUEST',  'client.manage', false),
  ('WORKSPACE', 'OWNER',  'project.create', true),
  ('WORKSPACE', 'ADMIN',  'project.create', true),
  ('WORKSPACE', 'MEMBER', 'project.create', true),
  ('WORKSPACE', 'GUEST',  'project.create', false),
  ('WORKSPACE', 'OWNER',  'project.manage', true),
  ('WORKSPACE', 'ADMIN',  'project.manage', true),
  ('WORKSPACE', 'MEMBER', 'project.manage', false),
  ('WORKSPACE', 'GUEST',  'project.manage', false),
  ('WORKSPACE', 'OWNER',  'workspace.manage_members', true),
  ('WORKSPACE', 'ADMIN',  'workspace.manage_members', true),
  ('WORKSPACE', 'MEMBER', 'workspace.manage_members', false),
  ('WORKSPACE', 'GUEST',  'workspace.manage_members', false),

  ('PROJECT', 'PROJECT_ADMIN', 'tasks.view',   true),
  ('PROJECT', 'EDITOR',        'tasks.view',   true),
  ('PROJECT', 'VIEWER',        'tasks.view',   true),
  ('PROJECT', 'PROJECT_ADMIN', 'tasks.create', true),
  ('PROJECT', 'EDITOR',        'tasks.create', true),
  ('PROJECT', 'VIEWER',        'tasks.create', false),
  ('PROJECT', 'PROJECT_ADMIN', 'tasks.edit',   true),
  ('PROJECT', 'EDITOR',        'tasks.edit',   true),
  ('PROJECT', 'VIEWER',        'tasks.edit',   false),
  ('PROJECT', 'PROJECT_ADMIN', 'tasks.delete', true),
  ('PROJECT', 'EDITOR',        'tasks.delete', true),
  ('PROJECT', 'VIEWER',        'tasks.delete', false),

  ('PROJECT', 'PROJECT_ADMIN', 'comments.view',   true),
  ('PROJECT', 'EDITOR',        'comments.view',   true),
  ('PROJECT', 'VIEWER',        'comments.view',   true),
  ('PROJECT', 'PROJECT_ADMIN', 'comments.create', true),
  ('PROJECT', 'EDITOR',        'comments.create', true),
  ('PROJECT', 'VIEWER',        'comments.create', true),
  ('PROJECT', 'PROJECT_ADMIN', 'comments.delete', true),
  ('PROJECT', 'EDITOR',        'comments.delete', false),
  ('PROJECT', 'VIEWER',        'comments.delete', false),

  ('PROJECT', 'PROJECT_ADMIN', 'files.view',   true),
  ('PROJECT', 'EDITOR',        'files.view',   true),
  ('PROJECT', 'VIEWER',        'files.view',   true),
  ('PROJECT', 'PROJECT_ADMIN', 'files.create', true),
  ('PROJECT', 'EDITOR',        'files.create', true),
  ('PROJECT', 'VIEWER',        'files.create', false),
  ('PROJECT', 'PROJECT_ADMIN', 'files.edit',   true),
  ('PROJECT', 'EDITOR',        'files.edit',   true),
  ('PROJECT', 'VIEWER',        'files.edit',   false),
  ('PROJECT', 'PROJECT_ADMIN', 'files.delete', true),
  ('PROJECT', 'EDITOR',        'files.delete', false),
  ('PROJECT', 'VIEWER',        'files.delete', false),

  ('PROJECT', 'PROJECT_ADMIN', 'members.view',   true),
  ('PROJECT', 'EDITOR',        'members.view',   true),
  ('PROJECT', 'VIEWER',        'members.view',   true),
  ('PROJECT', 'PROJECT_ADMIN', 'members.create', true),
  ('PROJECT', 'EDITOR',        'members.create', false),
  ('PROJECT', 'VIEWER',        'members.create', false),
  ('PROJECT', 'PROJECT_ADMIN', 'members.edit',   true),
  ('PROJECT', 'EDITOR',        'members.edit',   false),
  ('PROJECT', 'VIEWER',        'members.edit',   false),
  ('PROJECT', 'PROJECT_ADMIN', 'members.delete', true),
  ('PROJECT', 'EDITOR',        'members.delete', false),
  ('PROJECT', 'VIEWER',        'members.delete', false),

  ('PROJECT', 'PROJECT_ADMIN', 'engagement.view',   true),
  ('PROJECT', 'EDITOR',        'engagement.view',   true),
  ('PROJECT', 'VIEWER',        'engagement.view',   true),
  ('PROJECT', 'PROJECT_ADMIN', 'engagement.edit',   true),
  ('PROJECT', 'EDITOR',        'engagement.edit',   false),
  ('PROJECT', 'VIEWER',        'engagement.edit',   false),
  ('PROJECT', 'PROJECT_ADMIN', 'engagement.delete', true),
  ('PROJECT', 'EDITOR',        'engagement.delete', false),
  ('PROJECT', 'VIEWER',        'engagement.delete', false),

  ('PROJECT', 'PROJECT_ADMIN', 'ai_review.view',   true),
  ('PROJECT', 'EDITOR',        'ai_review.view',   true),
  ('PROJECT', 'VIEWER',        'ai_review.view',   true),
  ('PROJECT', 'PROJECT_ADMIN', 'ai_review.create', true),
  ('PROJECT', 'EDITOR',        'ai_review.create', true),
  ('PROJECT', 'VIEWER',        'ai_review.create', false)
ON CONFLICT (scope, role, permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- task_templates / task_template_items — superadmin-built, but readable by
-- any authenticated user (the "apply a template" picker needs to list them
-- for ordinary project creators, per the template-use permission decision).
-- ---------------------------------------------------------------------------
ALTER TABLE task_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_templates_select ON task_templates;
CREATE POLICY task_templates_select ON task_templates
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS task_templates_write ON task_templates;
CREATE POLICY task_templates_write ON task_templates
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

ALTER TABLE task_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_template_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_template_items_select ON task_template_items;
CREATE POLICY task_template_items_select ON task_template_items
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS task_template_items_write ON task_template_items;
CREATE POLICY task_template_items_write ON task_template_items
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

-- ---------------------------------------------------------------------------
-- engagement_types / engagement_type_templates — same shape as task_templates.
-- ---------------------------------------------------------------------------
ALTER TABLE engagement_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_types FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engagement_types_select ON engagement_types;
CREATE POLICY engagement_types_select ON engagement_types
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS engagement_types_write ON engagement_types;
CREATE POLICY engagement_types_write ON engagement_types
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

ALTER TABLE engagement_type_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_type_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engagement_type_templates_select ON engagement_type_templates;
CREATE POLICY engagement_type_templates_select ON engagement_type_templates
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS engagement_type_templates_write ON engagement_type_templates;
CREATE POLICY engagement_type_templates_write ON engagement_type_templates
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

-- project_engagement_type — which engagement type (if any) a project was
-- created from. Visibility follows the project itself; writing it is really
-- just "creating tasks in bulk" (a template application), so it's gated the
-- same way tasks.create is.
ALTER TABLE project_engagement_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_engagement_type FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_engagement_type_select ON project_engagement_type;
CREATE POLICY project_engagement_type_select ON project_engagement_type
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND can_access_project(p.id, p.workspace_id, p.visibility))
  );

DROP POLICY IF EXISTS project_engagement_type_write ON project_engagement_type;
CREATE POLICY project_engagement_type_write ON project_engagement_type
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
        AND (is_workspace_admin(p.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'tasks.create'))
    )
  );

-- ---------------------------------------------------------------------------
-- smtp_settings / ai_provider_settings — platform-wide singletons. SELECT is
-- open to any authenticated user because the app itself needs to read these
-- during normal operation on behalf of ordinary users (sending an invite
-- email, running an AI review) — restricting reads to super admins would
-- break those features for everyone else. The settings *page* that displays
-- and edits these is gated at the app layer (superadmin-only route) and here
-- via the write policy; the encrypted secret columns are never sent to the
-- browser regardless (see services/smtp-settings.ts, services/ai-settings.ts).
-- ---------------------------------------------------------------------------
ALTER TABLE smtp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE smtp_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS smtp_settings_select ON smtp_settings;
CREATE POLICY smtp_settings_select ON smtp_settings
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS smtp_settings_write ON smtp_settings;
CREATE POLICY smtp_settings_write ON smtp_settings
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

ALTER TABLE ai_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_settings_select ON ai_provider_settings;
CREATE POLICY ai_provider_settings_select ON ai_provider_settings
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS ai_provider_settings_write ON ai_provider_settings;
CREATE POLICY ai_provider_settings_write ON ai_provider_settings
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

-- ---------------------------------------------------------------------------
-- project_files — References tab + AI-reviewed documents. Read follows plain
-- project visibility; upload is gated by files.create; recategorizing
-- (the "Add to References" promote action) by files.edit; delete by the
-- uploader themselves, files.delete, or workspace admin.
-- ---------------------------------------------------------------------------
ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_files FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_files_select ON project_files;
CREATE POLICY project_files_select ON project_files
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND can_perform_on_project(p.id, p.workspace_id, p.visibility, 'files.view'))
  );

DROP POLICY IF EXISTS project_files_insert ON project_files;
CREATE POLICY project_files_insert ON project_files
  FOR INSERT WITH CHECK (
    uploaded_by = current_app_user_id()
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
        AND (is_workspace_admin(p.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'files.create'))
    )
  );

-- Fixes a pre-existing gap: there was never an UPDATE policy on
-- project_files at all, so services/project-files.ts's
-- promoteFileToReferences (flipping AI_REVIEWED -> REFERENCE) would have
-- failed under FORCE ROW LEVEL SECURITY's default-deny.
DROP POLICY IF EXISTS project_files_update ON project_files;
CREATE POLICY project_files_update ON project_files
  FOR UPDATE USING (
    uploaded_by = current_app_user_id()
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
        AND (is_workspace_admin(p.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'files.edit'))
    )
  );

DROP POLICY IF EXISTS project_files_delete ON project_files;
CREATE POLICY project_files_delete ON project_files
  FOR DELETE USING (
    uploaded_by = current_app_user_id()
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
        AND (is_workspace_admin(p.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'files.delete'))
    )
  );

-- ============================================================================
-- PART 2 — Custom roles, client-level & task-level collaborator access,
-- and the workspace-isolation rework.
--
-- The access model changes here:
--   - Plain workspace membership (MEMBER/GUEST) NO LONGER implies visibility
--     into a workspace's clients/projects/tasks. Only the workspace's own
--     owner or a workspace ADMIN (is_workspace_admin(), unchanged, retained
--     deliberately as an oversight bypass) or a super admin sees everything
--     by default. Everyone else needs an explicit grant: a client_members
--     row (client-wide), a project_members / project_custom_role_members
--     row (one engagement), or a task_members row (one task only).
--   - PUBLIC_TO_WORKSPACE, as a functioning concept, goes away: it no longer
--     grants access to anyone (see can_access_project/can_perform_on_project
--     below — the visibility argument is still accepted, for call-site
--     compatibility, but is no longer consulted).
--   - Custom roles plug into the SAME role_permissions matrix has_permission()
--     already reads — a custom role's grants live at (scope, role, key)
--     where `role` is the custom role's id cast to text and `scope` is
--     'PROJECT' (assigned via project_custom_role_members) or 'CLIENT'
--     (assigned via client_members, applying across every one of that
--     client's engagements at once). No new matrix table needed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- New bypass helpers (same SECURITY DEFINER + rls_helper pattern used above,
-- for the same two reasons: self-referential recursion (a table's own
-- policy needs a fact about that same table) and cross-table checks that
-- don't match the referenced table's own SELECT policy).
-- ---------------------------------------------------------------------------

GRANT SELECT ON custom_roles, client_members, project_custom_role_members, task_members, clients, tasks
  TO rls_helper;

-- Does the current user hold ANY client_members grant for this client
-- (regardless of which custom role)?
CREATE OR REPLACE FUNCTION is_client_member(c_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM client_members cm
    WHERE cm.client_id = c_id AND cm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_client_member(uuid) OWNER TO rls_helper;

-- Bypasses clients' own (now client_members-dependent) SELECT policy so a
-- client's creator can see the row they just inserted, mirroring
-- is_project_creator() above.
CREATE OR REPLACE FUNCTION is_client_creator(c_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM clients c WHERE c.id = c_id AND c.created_by = current_app_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_client_creator(uuid) OWNER TO rls_helper;

-- A project's client_id, read bypassing projects' own SELECT policy (which
-- itself depends on can_access_project(), which depends on this) — plain
-- column lookup, no recursion risk.
CREATE OR REPLACE FUNCTION project_client_id(p_id uuid) RETURNS uuid AS $$
  SELECT client_id FROM projects WHERE id = p_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION project_client_id(uuid) OWNER TO rls_helper;

-- CLIENT-scope custom-role access reaches every engagement under that
-- client at once — a project with no client_id simply never matches here.
CREATE OR REPLACE FUNCTION is_client_member_for_project(p_id uuid) RETURNS boolean AS $$
  SELECT project_client_id(p_id) IS NOT NULL AND is_client_member(project_client_id(p_id));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION has_client_permission(c_id uuid, p_key text) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM client_members cm
    WHERE cm.client_id = c_id
      AND cm.user_id = current_app_user_id()
      AND has_permission('CLIENT', cm.custom_role_id::text, p_key)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_client_permission(uuid, text) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION has_client_permission_for_project(p_id uuid, p_key text) RETURNS boolean AS $$
  SELECT project_client_id(p_id) IS NOT NULL AND has_client_permission(project_client_id(p_id), p_key);
$$ LANGUAGE sql STABLE;

-- Does the current user hold a project-scoped custom role on this project
-- (layered on top of, or instead of, a built-in project_members role)?
CREATE OR REPLACE FUNCTION is_project_custom_role_member(p_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM project_custom_role_members pcrm
    WHERE pcrm.project_id = p_id AND pcrm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_project_custom_role_member(uuid) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION has_project_custom_role_permission(p_id uuid, p_key text) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM project_custom_role_members pcrm
    WHERE pcrm.project_id = p_id
      AND pcrm.user_id = current_app_user_id()
      AND has_permission('PROJECT', pcrm.custom_role_id::text, p_key)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_project_custom_role_permission(uuid, text) OWNER TO rls_helper;

-- Narrow, single-task grants — deliberately NOT routed through the
-- permissions matrix (see task_members' schema comment): just VIEWER/EDITOR.
CREATE OR REPLACE FUNCTION is_task_member(t_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM task_members tm
    WHERE tm.task_id = t_id AND tm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION is_task_member(uuid) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION has_task_edit_permission(t_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM task_members tm
    WHERE tm.task_id = t_id AND tm.user_id = current_app_user_id() AND tm.role = 'EDITOR'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_task_edit_permission(uuid) OWNER TO rls_helper;

-- Pending client/task invite lookups — same bootstrap reasoning as
-- has_pending_workspace_invite()/has_pending_project_invite() above: an
-- invite addressed to an email predating the invitee's account has
-- invitee_user_id still NULL, so the invitations table's own SELECT policy
-- (inviter/invitee/admin) doesn't yet match the accepting user.
GRANT SELECT ON client_invitations, task_invitations TO rls_helper;

CREATE OR REPLACE FUNCTION has_pending_client_invite(c_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM client_invitations ci
    WHERE ci.client_id = c_id
      AND ci.status = 'PENDING'
      AND (
        ci.invitee_user_id = current_app_user_id()
        OR ci.invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_pending_client_invite(uuid) OWNER TO rls_helper;

CREATE OR REPLACE FUNCTION has_pending_task_invite(t_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_invitations ti
    WHERE ti.task_id = t_id
      AND ti.status = 'PENDING'
      AND (
        ti.invitee_user_id = current_app_user_id()
        OR ti.invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
ALTER FUNCTION has_pending_task_invite(uuid) OWNER TO rls_helper;

-- ---------------------------------------------------------------------------
-- Overrides: these CREATE OR REPLACE the same-named functions/policies
-- defined earlier in this file. Postgres just swaps the catalog entry — the
-- later definition (this one) wins for every subsequent query, so this is a
-- deliberate "layer a rework on top" structure rather than a duplicate.
-- ---------------------------------------------------------------------------

-- can_access_project: no longer grants anything via PUBLIC_TO_WORKSPACE +
-- plain workspace membership. Visibility now requires one of: workspace
-- owner/admin oversight, a direct project_members row, a project-scoped
-- custom role, or a CLIENT-scope custom role covering this project's client.
CREATE OR REPLACE FUNCTION can_access_project(p_id uuid, ws_id uuid, visibility project_visibility) RETURNS boolean AS $$
  SELECT
    is_workspace_admin(ws_id)
    OR is_project_member(p_id)
    OR is_project_custom_role_member(p_id)
    OR is_client_member_for_project(p_id);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION can_perform_on_project(p_id uuid, ws_id uuid, visibility project_visibility, p_key text) RETURNS boolean AS $$
  SELECT
    is_workspace_admin(ws_id)
    OR has_project_permission(p_id, p_key)
    OR has_project_custom_role_permission(p_id, p_key)
    OR has_client_permission_for_project(p_id, p_key);
$$ LANGUAGE sql STABLE;

-- clients_select: workspace membership alone no longer implies visibility —
-- needs owner/admin oversight, having created the client, or an explicit
-- client_members grant.
DROP POLICY IF EXISTS clients_select ON clients;
CREATE POLICY clients_select ON clients
  FOR SELECT USING (
    is_workspace_admin(workspace_id)
    OR created_by = current_app_user_id()
    OR is_client_member(id)
  );

-- tasks_select: add the task_members narrow-ACL branch on top of the
-- (already reworked, via can_access_project) engagement-level check, now
-- additionally gated by the tasks.view permission for anyone reaching it
-- through project-level access (a task_members grant bypasses this — its
-- own VIEWER/EDITOR levels aren't matrix-governed, see task_members'
-- schema comment).
-- can_perform_on_project's own EXISTS already implies project access (via
-- whichever path grants the permission), so it's sufficient on its own —
-- no need to separately AND can_access_project().
DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks
  FOR SELECT USING (
    is_task_member(id)
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id AND can_perform_on_project(p.id, p.workspace_id, p.visibility, 'tasks.view')
    )
  );

-- tasks writes are split by statement type (a single FOR ALL policy can't
-- check a different permission key per action) so tasks.create/edit/delete
-- each gate their own operation instead of one blanket "task.write".
DROP POLICY IF EXISTS tasks_write ON tasks;

DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks
  FOR INSERT WITH CHECK (
    is_workspace_admin(workspace_id)
    OR can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.create'
    )
  );

DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks
  FOR UPDATE USING (
    is_workspace_admin(workspace_id)
    OR has_task_edit_permission(id)
    OR can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.edit'
    )
  );

DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks
  FOR DELETE USING (
    is_workspace_admin(workspace_id)
    OR can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.delete'
    )
  );

-- task_comments: a task_members grant (VIEWER or EDITOR) can read and post
-- comments on that one task, same latitude VIEWER-role project members get.
-- can_perform_on_project's own EXISTS already requires the row-existence
-- checks can_access_project would add on top (project membership / custom
-- role / client membership, whichever path grants the permission) — no
-- need to AND them together.
DROP POLICY IF EXISTS task_comments_select ON task_comments;
CREATE POLICY task_comments_select ON task_comments
  FOR SELECT USING (
    is_task_member(task_id)
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = task_id AND can_perform_on_project(p.id, p.workspace_id, p.visibility, 'comments.view')
    )
  );

DROP POLICY IF EXISTS task_comments_insert ON task_comments;
CREATE POLICY task_comments_insert ON task_comments
  FOR INSERT WITH CHECK (
    author_id = current_app_user_id()
    AND (
      is_task_member(task_id)
      OR EXISTS (
        SELECT 1 FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.id = task_id AND can_perform_on_project(p.id, p.workspace_id, p.visibility, 'comments.create')
      )
    )
  );

DROP POLICY IF EXISTS task_comments_delete ON task_comments;
CREATE POLICY task_comments_delete ON task_comments
  FOR DELETE USING (
    author_id = current_app_user_id() -- you can always delete your own
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = task_id
        AND (is_workspace_admin(t.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'comments.delete'))
    )
  );

-- task_dependencies: a task_members grant on the successor task lets that
-- collaborator see the dependency; editing it requires the EDITOR level.
-- Kept as a single FOR ALL (add/remove a dependency is really "editing the
-- task's dependency graph") since there's no separate create/delete
-- distinction meaningful enough to split, unlike tasks itself above.
DROP POLICY IF EXISTS task_dependencies_select ON task_dependencies;
CREATE POLICY task_dependencies_select ON task_dependencies
  FOR SELECT USING (
    is_task_member(successor_task_id)
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = successor_task_id AND can_access_project(p.id, p.workspace_id, p.visibility)
    )
  );

DROP POLICY IF EXISTS task_dependencies_write ON task_dependencies;
CREATE POLICY task_dependencies_write ON task_dependencies
  FOR ALL USING (
    has_task_edit_permission(successor_task_id)
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = successor_task_id
        AND (is_workspace_admin(t.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'tasks.edit'))
    )
  );

-- ---------------------------------------------------------------------------
-- task_checklist_items — a lightweight punch-list inside a task (checkbox +
-- title + optional remarks), distinct from the tasks table's own
-- parent/child self-reference (the "Subtasks" section — real linked tasks
-- with their own status/assignee). Visibility mirrors task_comments_select
-- (a task_members grant, or project-level tasks.view); every write (add,
-- toggle-complete, edit remarks, delete) is gated by a single tasks.edit
-- check — same bar as editing the task's own title/description — since
-- there's no create/toggle/delete distinction meaningful enough to split,
-- same reasoning as task_dependencies_write below it.
-- ---------------------------------------------------------------------------
ALTER TABLE task_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_checklist_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_checklist_items_select ON task_checklist_items;
CREATE POLICY task_checklist_items_select ON task_checklist_items
  FOR SELECT USING (
    is_task_member(task_id)
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = task_id AND can_perform_on_project(p.id, p.workspace_id, p.visibility, 'tasks.view')
    )
  );

DROP POLICY IF EXISTS task_checklist_items_write ON task_checklist_items;
CREATE POLICY task_checklist_items_write ON task_checklist_items
  FOR ALL USING (
    has_task_edit_permission(task_id)
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = task_id
        AND (is_workspace_admin(t.workspace_id) OR can_perform_on_project(p.id, p.workspace_id, p.visibility, 'tasks.edit'))
    )
  );

-- ---------------------------------------------------------------------------
-- custom_roles — superadmin-only to create/edit/delete (mirrors
-- task_templates); readable by any authenticated user so invite pickers and
-- the permission-matrix UI can list them.
-- ---------------------------------------------------------------------------
ALTER TABLE custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_roles_select ON custom_roles;
CREATE POLICY custom_roles_select ON custom_roles
  FOR SELECT USING (current_app_user_id() IS NOT NULL);

DROP POLICY IF EXISTS custom_roles_write ON custom_roles;
CREATE POLICY custom_roles_write ON custom_roles
  FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin());

-- ---------------------------------------------------------------------------
-- client_members — who besides the workspace owner/admin/super admin can see
-- and act on a client (and, transitively via is_client_member_for_project,
-- every one of that client's engagements).
-- ---------------------------------------------------------------------------
ALTER TABLE client_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_members_select ON client_members;
CREATE POLICY client_members_select ON client_members
  FOR SELECT USING (
    is_workspace_admin(workspace_id)
    OR user_id = current_app_user_id()
    OR is_client_member(client_id) -- other members of the same client can see the roster
  );

DROP POLICY IF EXISTS client_members_insert ON client_members;
CREATE POLICY client_members_insert ON client_members
  FOR INSERT WITH CHECK (
    is_workspace_admin(workspace_id)
    OR has_workspace_permission(workspace_id, 'client.manage')
    OR is_client_creator(client_id)
    -- Invite acceptance bootstrap, same shape as project_members_insert's.
    OR (user_id = current_app_user_id() AND has_pending_client_invite(client_id))
  );

DROP POLICY IF EXISTS client_members_delete ON client_members;
CREATE POLICY client_members_delete ON client_members
  FOR DELETE USING (
    is_workspace_admin(workspace_id)
    OR has_workspace_permission(workspace_id, 'client.manage')
    OR is_client_creator(client_id)
    OR user_id = current_app_user_id() -- self-removal
  );

-- ---------------------------------------------------------------------------
-- project_custom_role_members — additive layer on top of project_members'
-- built-in role. Same actor set as project_members' own policies.
-- ---------------------------------------------------------------------------
ALTER TABLE project_custom_role_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_custom_role_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_custom_role_members_select ON project_custom_role_members;
CREATE POLICY project_custom_role_members_select ON project_custom_role_members
  FOR SELECT USING (
    is_project_member(project_id)
    OR is_workspace_admin(project_workspace_id(project_id))
    OR user_id = current_app_user_id()
  );

DROP POLICY IF EXISTS project_custom_role_members_insert ON project_custom_role_members;
CREATE POLICY project_custom_role_members_insert ON project_custom_role_members
  FOR INSERT WITH CHECK (
    can_perform_on_project(
      project_id, project_workspace_id(project_id),
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'members.edit'
    )
    -- The accepting user's base project_members row is inserted in the same
    -- transaction just before this one (see services/project-invitations.ts),
    -- so is_project_member() is already true by the time this runs.
    OR (user_id = current_app_user_id() AND is_project_member(project_id))
  );

DROP POLICY IF EXISTS project_custom_role_members_delete ON project_custom_role_members;
CREATE POLICY project_custom_role_members_delete ON project_custom_role_members
  FOR DELETE USING (
    can_perform_on_project(
      project_id, project_workspace_id(project_id),
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'members.edit'
    )
    OR user_id = current_app_user_id()
  );

-- ---------------------------------------------------------------------------
-- task_members — one-task-only ACL. Anyone who could already write tasks in
-- the project (or the workspace admin) can hand out a narrow grant; the
-- grantee themselves can always see their own row and self-remove.
-- ---------------------------------------------------------------------------
ALTER TABLE task_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_members_select ON task_members;
CREATE POLICY task_members_select ON task_members
  FOR SELECT USING (
    user_id = current_app_user_id()
    OR can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.edit'
    )
  );

DROP POLICY IF EXISTS task_members_insert ON task_members;
CREATE POLICY task_members_insert ON task_members
  FOR INSERT WITH CHECK (
    can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.edit'
    )
    -- Invite acceptance bootstrap.
    OR (user_id = current_app_user_id() AND has_pending_task_invite(task_id))
  );

DROP POLICY IF EXISTS task_members_delete ON task_members;
CREATE POLICY task_members_delete ON task_members
  FOR DELETE USING (
    can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.edit'
    )
    OR user_id = current_app_user_id() -- self-removal
  );

-- ---------------------------------------------------------------------------
-- client_invitations / task_invitations — same token/status/expiry shape and
-- security posture as project_invitations above.
-- ---------------------------------------------------------------------------
ALTER TABLE client_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_invitations_select ON client_invitations;
CREATE POLICY client_invitations_select ON client_invitations
  FOR SELECT USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id()
    OR is_workspace_admin(workspace_id)
  );

DROP POLICY IF EXISTS client_invitations_insert ON client_invitations;
CREATE POLICY client_invitations_insert ON client_invitations
  FOR INSERT WITH CHECK (
    inviter_id = current_app_user_id()
    AND (is_workspace_admin(workspace_id) OR is_client_member(client_id) OR is_client_creator(client_id))
  );

DROP POLICY IF EXISTS client_invitations_update ON client_invitations;
CREATE POLICY client_invitations_update ON client_invitations
  FOR UPDATE USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id()
    OR invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
    OR is_workspace_admin(workspace_id)
  );

ALTER TABLE task_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_invitations_select ON task_invitations;
CREATE POLICY task_invitations_select ON task_invitations
  FOR SELECT USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id()
    OR is_workspace_admin(workspace_id)
  );

DROP POLICY IF EXISTS task_invitations_insert ON task_invitations;
CREATE POLICY task_invitations_insert ON task_invitations
  FOR INSERT WITH CHECK (
    inviter_id = current_app_user_id()
    AND can_perform_on_project(
      project_id, workspace_id,
      (SELECT p.visibility FROM projects p WHERE p.id = project_id),
      'tasks.edit'
    )
  );

DROP POLICY IF EXISTS task_invitations_update ON task_invitations;
CREATE POLICY task_invitations_update ON task_invitations
  FOR UPDATE USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id()
    OR invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
    OR is_workspace_admin(workspace_id)
  );
