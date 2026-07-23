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

-- Is the current user a member of the given workspace (any role)?
CREATE OR REPLACE FUNCTION is_workspace_member(ws_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id AND wm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE;

-- Is the current user OWNER/ADMIN of the given workspace?
CREATE OR REPLACE FUNCTION is_workspace_admin(ws_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id
      AND wm.user_id = current_app_user_id()
      AND wm.role IN ('OWNER', 'ADMIN')
  );
$$ LANGUAGE sql STABLE;

-- Is the current user a direct member of the given project (project-scoped
-- guest access included) regardless of workspace-level membership?
CREATE OR REPLACE FUNCTION is_project_member(p_id uuid) RETURNS boolean AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = p_id AND pm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE;

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
    -- requires an existing membership row to already exist.
    OR (
      role = 'OWNER'
      AND user_id = current_app_user_id()
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id AND w.owner_id = current_app_user_id())
    )
    -- Invite acceptance: a user may insert themselves as GUEST when
    -- there's a matching pending invitation addressed to them (by id or,
    -- for invites sent before they had an account, by email) — mirrors
    -- the email-match check acceptProjectInvite already performs in
    -- services/invitations.ts before running this insert.
    OR (
      role = 'GUEST'
      AND user_id = current_app_user_id()
      AND EXISTS (
        SELECT 1 FROM project_invitations pi
        WHERE pi.workspace_id = workspace_members.workspace_id
          AND pi.status = 'PENDING'
          AND (
            pi.invitee_user_id = current_app_user_id()
            OR pi.invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
          )
      )
    )
  );

DROP POLICY IF EXISTS workspace_members_update ON workspace_members;
CREATE POLICY workspace_members_update ON workspace_members
  FOR UPDATE USING (is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS workspace_members_delete ON workspace_members;
CREATE POLICY workspace_members_delete ON workspace_members
  FOR DELETE USING (
    is_workspace_admin(workspace_id)
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

DROP POLICY IF EXISTS clients_insert ON clients;
CREATE POLICY clients_insert ON clients
  FOR INSERT WITH CHECK (is_workspace_member(workspace_id) AND created_by = current_app_user_id());

DROP POLICY IF EXISTS clients_update ON clients;
CREATE POLICY clients_update ON clients
  FOR UPDATE USING (is_workspace_admin(workspace_id) OR created_by = current_app_user_id());

DROP POLICY IF EXISTS clients_delete ON clients;
CREATE POLICY clients_delete ON clients
  FOR DELETE USING (is_workspace_admin(workspace_id));

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
  FOR INSERT WITH CHECK (is_workspace_member(workspace_id));

DROP POLICY IF EXISTS projects_update ON projects;
CREATE POLICY projects_update ON projects
  FOR UPDATE USING (
    is_workspace_admin(workspace_id)
    OR EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = id AND pm.user_id = current_app_user_id() AND pm.role = 'PROJECT_ADMIN'
    )
  );

DROP POLICY IF EXISTS projects_delete ON projects;
CREATE POLICY projects_delete ON projects
  FOR DELETE USING (is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- project_members
-- ---------------------------------------------------------------------------
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_members_select ON project_members;
CREATE POLICY project_members_select ON project_members
  FOR SELECT USING (
    is_project_member(project_id)
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id AND is_workspace_admin(p.workspace_id)
    )
  );

DROP POLICY IF EXISTS project_members_insert ON project_members;
CREATE POLICY project_members_insert ON project_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
        AND (is_workspace_admin(p.workspace_id)
             OR EXISTS (
               SELECT 1 FROM project_members pm2
               WHERE pm2.project_id = project_id AND pm2.user_id = current_app_user_id() AND pm2.role = 'PROJECT_ADMIN'
             ))
    )
    -- Invite acceptance bootstrap — same shape as workspace_members_insert
    -- above: a user may insert themselves when a matching pending invite
    -- exists, since they're not yet a project member (that's the whole
    -- point of accepting) and so can't satisfy either branch above.
    OR (
      user_id = current_app_user_id()
      AND EXISTS (
        SELECT 1 FROM project_invitations pi
        WHERE pi.project_id = project_members.project_id
          AND pi.status = 'PENDING'
          AND (
            pi.invitee_user_id = current_app_user_id()
            OR pi.invitee_email = (SELECT u.email FROM users u WHERE u.id = current_app_user_id())
          )
      )
    )
  );

DROP POLICY IF EXISTS project_members_delete ON project_members;
CREATE POLICY project_members_delete ON project_members
  FOR DELETE USING (
    user_id = current_app_user_id() -- self-removal
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id AND is_workspace_admin(p.workspace_id)
    )
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
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = project_id
        AND pm.user_id = current_app_user_id()
        AND pm.role IN ('PROJECT_ADMIN', 'EDITOR')
    )
    OR is_workspace_admin(workspace_id)
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
      JOIN project_members pm ON pm.project_id = t.project_id
      WHERE t.id = successor_task_id
        AND pm.user_id = current_app_user_id()
        AND pm.role IN ('PROJECT_ADMIN', 'EDITOR')
    )
    OR EXISTS (
      SELECT 1 FROM tasks t WHERE t.id = successor_task_id AND is_workspace_admin(t.workspace_id)
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
      WHERE t.id = task_id AND can_access_project(p.id, p.workspace_id, p.visibility)
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
