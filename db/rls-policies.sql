-- ============================================================================
-- Row-Level Security policies + supplementary constraints
-- Run AFTER the Drizzle-generated migration that creates the base tables.
--
-- Strategy: every request sets two session-local GUCs at the top of its
-- transaction (via a Postgres pool middleware — see db/with-rls-context.ts):
--
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_workspace_id = '<uuid>';   -- the ACTIVE workspace
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

-- Is the current user a member of the given workspace (any role)?
CREATE OR REPLACE FUNCTION is_workspace_member(ws_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id AND wm.user_id = current_app_user_id()
  );
$$ LANGUAGE sql STABLE;

-- Is the current user OWNER/ADMIN of the given workspace?
CREATE OR REPLACE FUNCTION is_workspace_admin(ws_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = ws_id
      AND wm.user_id = current_app_user_id()
      AND wm.role IN ('OWNER', 'ADMIN')
  );
$$ LANGUAGE sql STABLE;

-- Is the current user a direct member of the given project (project-scoped
-- guest access included) regardless of workspace-level membership?
CREATE OR REPLACE FUNCTION is_project_member(p_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
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

CREATE POLICY workspaces_select ON workspaces
  FOR SELECT USING (is_workspace_member(id));

CREATE POLICY workspaces_update ON workspaces
  FOR UPDATE USING (is_workspace_admin(id));

CREATE POLICY workspaces_delete ON workspaces
  FOR DELETE USING (owner_id = current_app_user_id());

-- Inserts happen via a SECURITY DEFINER function during signup (see below),
-- so no INSERT policy is granted to the app role directly.

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT USING (is_workspace_member(workspace_id));

CREATE POLICY workspace_members_insert ON workspace_members
  FOR INSERT WITH CHECK (is_workspace_admin(workspace_id));

CREATE POLICY workspace_members_update ON workspace_members
  FOR UPDATE USING (is_workspace_admin(workspace_id));

CREATE POLICY workspace_members_delete ON workspace_members
  FOR DELETE USING (
    is_workspace_admin(workspace_id)
    OR user_id = current_app_user_id() -- self-removal ("leave workspace")
  );

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY projects_select ON projects
  FOR SELECT USING (can_access_project(id, workspace_id, visibility));

CREATE POLICY projects_insert ON projects
  FOR INSERT WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY projects_update ON projects
  FOR UPDATE USING (
    is_workspace_admin(workspace_id)
    OR EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = id AND pm.user_id = current_app_user_id() AND pm.role = 'PROJECT_ADMIN'
    )
  );

CREATE POLICY projects_delete ON projects
  FOR DELETE USING (is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- project_members
-- ---------------------------------------------------------------------------
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members FORCE ROW LEVEL SECURITY;

CREATE POLICY project_members_select ON project_members
  FOR SELECT USING (
    is_project_member(project_id)
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id AND is_workspace_admin(p.workspace_id)
    )
  );

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
  );

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

CREATE POLICY project_invitations_select ON project_invitations
  FOR SELECT USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id()
    OR is_workspace_admin(workspace_id)
  );

CREATE POLICY project_invitations_insert ON project_invitations
  FOR INSERT WITH CHECK (
    inviter_id = current_app_user_id()
    AND (is_workspace_admin(workspace_id) OR is_project_member(project_id))
  );

CREATE POLICY project_invitations_update ON project_invitations
  FOR UPDATE USING (
    inviter_id = current_app_user_id()
    OR invitee_user_id = current_app_user_id() -- accept/decline
    OR is_workspace_admin(workspace_id)
  );

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tasks_select ON tasks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id AND can_access_project(p.id, p.workspace_id, p.visibility)
    )
  );

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
-- activity_logs — append-only, readable by anyone who can see the project/workspace
-- ---------------------------------------------------------------------------
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY activity_logs_select ON activity_logs
  FOR SELECT USING (is_workspace_member(workspace_id));

CREATE POLICY activity_logs_insert ON activity_logs
  FOR INSERT WITH CHECK (is_workspace_member(workspace_id));

-- No UPDATE/DELETE policy is created for activity_logs -> table is
-- effectively immutable to the application role (audit integrity).
