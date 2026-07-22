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

CREATE POLICY workspaces_select ON workspaces
  FOR SELECT USING (is_workspace_member(id));

CREATE POLICY workspaces_update ON workspaces
  FOR UPDATE USING (is_workspace_admin(id));

CREATE POLICY workspaces_delete ON workspaces
  FOR DELETE USING (owner_id = current_app_user_id() OR is_super_admin());

-- A workspace can only be inserted by the user who will own it (checked
-- against current_app_user_id(), not the client-supplied owner_id — see
-- auth/signup.ts and services/workspaces.ts, both of which set the RLS
-- session to the owner's own id before this insert runs).
CREATE POLICY workspaces_insert ON workspaces
  FOR INSERT WITH CHECK (owner_id = current_app_user_id() OR is_super_admin());

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT USING (is_workspace_member(workspace_id));

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
