/**
 * RBAC permissions matrix — service layer.
 *
 * Mirrors the DB-side design in db/rls-policies.sql: `permissions` is a
 * fixed, developer-maintained catalog; `role_permissions` is the actual
 * tickbox grid a super admin edits. RLS enforces this independently at the
 * database layer (has_permission() / has_workspace_permission() /
 * has_project_permission() there) — this file is what the app layer (route
 * handlers, other services) consults so an unauthorized action gets a clean
 * 403 instead of surfacing as a raw Postgres RLS error.
 *
 * The role_permissions table is tiny (roles x permissions, currently ~40
 * rows) and read on nearly every authorization check across the app, so
 * it's cached in memory with a short TTL rather than hitting the DB every
 * time — invalidated immediately on any write from the matrix UI.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { permissions, rolePermissions, projects, projectMembers, projectCustomRoleMembers, clientMembers, workspaceMembers } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}

// CLIENT was added alongside custom roles: a CLIENT-scoped custom role's
// grants live in role_permissions the same way a PROJECT-scoped one's do
// (role = the custom role's id, cast to text) — see db/rls-policies.sql's
// has_client_permission()/has_project_custom_role_permission().
type Scope = "WORKSPACE" | "PROJECT" | "CLIENT";

const CACHE_TTL_MS = 15_000;
let cache: { map: Map<string, boolean>; loadedAt: number } | null = null;

async function loadMatrix(): Promise<Map<string, boolean>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.map;
  const rows = await db.query.rolePermissions.findMany();
  const map = new Map(rows.map((r) => [`${r.scope}:${r.role}:${r.permissionKey}`, r.granted]));
  cache = { map, loadedAt: Date.now() };
  return map;
}

export function invalidatePermissionsCache() {
  cache = null;
}

/** Raw role -> permission lookup, independent of who the current user is. */
export async function roleHasPermission(scope: Scope, role: string, key: string): Promise<boolean> {
  const map = await loadMatrix();
  return map.get(`${scope}:${role}:${key}`) ?? false;
}

/**
 * Full matrix for the superadmin UI: every permission in the catalog, with
 * every role's current grant (defaulting to false for any combination that
 * has no row yet, so the UI never shows a blank cell).
 *
 * The permission catalog itself only has WORKSPACE and PROJECT rows (there
 * are no CLIENT-scoped permission *keys* — see db/rls-policies.sql's
 * has_client_permission()). Custom roles plug into the PROJECT rows instead:
 * a superadmin-created role scoped PROJECT gets its own column right next to
 * PROJECT_ADMIN/EDITOR/VIEWER; one scoped CLIENT gets a column too (labeled
 * to make clear its grant applies workspace-wide across a client's
 * engagements, not to one project) — both read/write role_permissions rows
 * keyed by the custom role's id.
 */
export async function getPermissionMatrix() {
  const [catalog, grants, customRolesList] = await Promise.all([
    db.query.permissions.findMany({ orderBy: (p, { asc }) => [asc(p.scope), asc(p.key)] }),
    db.query.rolePermissions.findMany(),
    db.query.customRoles.findMany({ orderBy: (r, { asc }) => [asc(r.name)] }),
  ]);

  const grantMap = new Map(grants.map((g) => [`${g.scope}:${g.role}:${g.permissionKey}`, g.granted]));
  const builtinRolesByScope: Record<"WORKSPACE" | "PROJECT", string[]> = {
    WORKSPACE: ["OWNER", "ADMIN", "MEMBER", "GUEST"],
    PROJECT: ["PROJECT_ADMIN", "EDITOR", "VIEWER"],
  };

  const customRoleColumns = customRolesList.map((r) => ({
    role: r.id,
    label: r.scope === "CLIENT" ? `${r.name} (client-wide)` : r.name,
    scope: r.scope as "PROJECT" | "CLIENT",
    isCustom: true as const,
  }));

  return catalog.map((p) => {
    const scope = p.scope as "WORKSPACE" | "PROJECT";
    const builtinColumns = builtinRolesByScope[scope].map((role) => ({
      role,
      label: role,
      // storageScope is what actually keys the role_permissions row this
      // cell reads/writes — for built-ins it's always the permission's own
      // catalog scope. The UI PATCHes with this, not the row's `scope`.
      storageScope: scope,
      isCustom: false as const,
      granted: grantMap.get(`${scope}:${role}:${p.key}`) ?? false,
    }));
    const customColumns =
      scope === "PROJECT"
        ? customRoleColumns.map((c) => ({
            role: c.role,
            label: c.label,
            // A CLIENT-scoped custom role's grant is keyed scope='CLIENT'
            // even though it's shown in the PROJECT row/tab (see comment
            // above getPermissionMatrix) — storageScope carries that through.
            storageScope: c.scope,
            isCustom: true as const,
            granted: grantMap.get(`${c.scope}:${c.role}:${p.key}`) ?? false,
          }))
        : [];
    return {
      key: p.key,
      label: p.label,
      scope,
      description: p.description,
      roles: [...builtinColumns, ...customColumns],
    };
  });
}

// Fixed action order within an aspect — not every aspect has every action
// (see db/rls-policies.sql's catalog INSERT for why each gap is deliberate:
// no "edit a comment" feature exists, creating a brand-new engagement is a
// workspace-scope action, etc.), so this is used to sort whatever actions
// DO exist for an aspect rather than to force a uniform 4-column grid.
const ACTION_ORDER = ["view", "create", "edit", "delete"];

const ASPECT_LABELS: Record<string, string> = {
  tasks: "Tasks",
  comments: "Comments",
  files: "Files",
  members: "Collaborators",
  engagement: "Engagement",
  ai_review: "AI Review",
};

/**
 * The PROJECT-scope permission catalog grouped into one row per aspect
 * (tasks/comments/files/members/engagement/ai_review), each with its
 * available actions in view→create→edit→delete order — this is what the
 * custom-role create/edit dialog renders as its inline tickbox grid.
 * CLIENT-scoped custom roles use this exact same catalog (see the
 * getPermissionMatrix comment above for why) — the caller decides where the
 * grant is stored (scope='PROJECT' vs scope='CLIENT'), not this function.
 */
export async function getProjectPermissionCatalogByAspect() {
  const catalog = await db.query.permissions.findMany({
    where: eq(permissions.scope, "PROJECT"),
  });

  const byAspect = new Map<string, typeof catalog>();
  for (const p of catalog) {
    const aspect = p.key.split(".")[0];
    if (!byAspect.has(aspect)) byAspect.set(aspect, []);
    byAspect.get(aspect)!.push(p);
  }

  return Array.from(byAspect.entries())
    .sort(([a], [b]) => ACTION_ORDER_ASPECTS_INDEX(a) - ACTION_ORDER_ASPECTS_INDEX(b))
    .map(([aspect, perms]) => ({
      aspect,
      label: ASPECT_LABELS[aspect] ?? aspect,
      actions: perms
        .slice()
        .sort((a, b) => {
          const actionOf = (key: string) => key.split(".")[1] ?? "";
          return ACTION_ORDER.indexOf(actionOf(a.key)) - ACTION_ORDER.indexOf(actionOf(b.key));
        })
        .map((p) => ({
          key: p.key,
          action: p.key.split(".")[1] ?? "",
          label: p.label,
          description: p.description,
        })),
    }));
}

// Stable display order for aspect rows themselves — matches the order
// they're inserted in db/rls-policies.sql's catalog.
const ASPECT_ORDER = ["tasks", "comments", "files", "members", "engagement", "ai_review"];
function ACTION_ORDER_ASPECTS_INDEX(aspect: string): number {
  const i = ASPECT_ORDER.indexOf(aspect);
  return i === -1 ? ASPECT_ORDER.length : i;
}

/** Superadmin-only: toggle a single (scope, role, permission) cell. */
export async function setRolePermission(params: {
  scope: Scope;
  role: string;
  permissionKey: string;
  granted: boolean;
  actingUserId: string;
}) {
  if (!(await isSuperAdmin(params.actingUserId))) {
    throw new NotAuthorizedError("Only a super admin can edit the permissions matrix.");
  }

  const existing = await db.query.rolePermissions.findFirst({
    where: and(
      eq(rolePermissions.scope, params.scope),
      eq(rolePermissions.role, params.role),
      eq(rolePermissions.permissionKey, params.permissionKey)
    ),
  });

  if (existing) {
    await db
      .update(rolePermissions)
      .set({ granted: params.granted, updatedAt: new Date(), updatedBy: params.actingUserId })
      .where(eq(rolePermissions.id, existing.id));
  } else {
    await db.insert(rolePermissions).values({
      scope: params.scope,
      role: params.role,
      permissionKey: params.permissionKey,
      granted: params.granted,
      updatedBy: params.actingUserId,
    });
  }

  invalidatePermissionsCache();
}

/**
 * Convenience helpers for services that need "does THIS user, in THIS
 * workspace/project, hold this permission" rather than the raw role lookup
 * — mirrors has_workspace_permission()/has_project_permission() in RLS.
 * Both include the super-admin bypass, same as their SQL counterparts.
 */
export async function userHasWorkspacePermission(
  workspaceRole: string | undefined,
  userId: string,
  key: string
): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;
  if (!workspaceRole) return false;
  return roleHasPermission("WORKSPACE", workspaceRole, key);
}

export async function userHasProjectPermission(
  projectRole: string | undefined,
  userId: string,
  key: string
): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;
  if (!projectRole) return false;
  return roleHasPermission("PROJECT", projectRole, key);
}

/**
 * Custom-role variant: `customRoleScope` is the ROLE's own scope (PROJECT or
 * CLIENT, from custom_roles.scope) — NOT the scope of the thing being acted
 * on. A CLIENT-scoped role still gates the same PROJECT-category permission
 * keys (task.write, file.upload, ...), just applied across every engagement
 * under that client rather than one at a time — see getPermissionMatrix's
 * comment above for why both live under role_permissions this way.
 */
export async function userHasCustomRolePermission(
  customRoleScope: "PROJECT" | "CLIENT",
  customRoleId: string,
  userId: string,
  key: string
): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;
  return roleHasPermission(customRoleScope, customRoleId, key);
}

/**
 * The single, authoritative app-layer "can this user do X on this
 * engagement" check — mirrors can_perform_on_project() in
 * db/rls-policies.sql (PART 2) exactly: workspace owner/admin oversight, OR
 * their built-in project_members role, OR ANY PROJECT-scoped custom role
 * they hold on this project, OR ANY CLIENT-scoped custom role they hold on
 * the project's client (grants apply across every one of that client's
 * engagements). A user can hold multiple custom roles at once — this
 * returns true if ANY of them grant `key` (OR across roles), same as RLS.
 *
 * Superseded services/tasks.ts's old canWrite()/requireProjectAccess()
 * pattern, which only ever consulted a single built-in project_members
 * role and so couldn't recognize access granted purely through a custom
 * role or a client-wide grant. Every service gating a PROJECT-scope aspect
 * action (tasks/comments/files/members/engagement/ai_review) should call
 * this rather than re-deriving a "role" and checking it in isolation.
 */
export async function userCanPerformOnProject(userId: string, projectId: string, key: string): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { workspaceId: true, clientId: true },
  });
  if (!project) return false;

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  if (workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN") return true;

  const [builtinMembership, customRoleMemberships, clientMemberships] = await Promise.all([
    db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
    }),
    db.query.projectCustomRoleMembers.findMany({
      where: and(eq(projectCustomRoleMembers.projectId, projectId), eq(projectCustomRoleMembers.userId, userId)),
    }),
    project.clientId
      ? db.query.clientMembers.findMany({
          where: and(eq(clientMembers.clientId, project.clientId), eq(clientMembers.userId, userId)),
        })
      : Promise.resolve([]),
  ]);

  if (builtinMembership && (await roleHasPermission("PROJECT", builtinMembership.role, key))) return true;
  for (const m of customRoleMemberships) {
    if (await roleHasPermission("PROJECT", m.customRoleId, key)) return true;
  }
  for (const m of clientMemberships) {
    if (await roleHasPermission("CLIENT", m.customRoleId, key)) return true;
  }
  return false;
}

/**
 * Does this user have ANY access to this engagement at all — mirrors
 * can_access_project() in db/rls-policies.sql (PART 2): workspace
 * owner/admin, a direct project_members row, any project-scoped custom
 * role, or any client-scoped custom role on the project's client.
 * Unlike userCanPerformOnProject, this doesn't check a specific
 * permission — it's the "can they see this engagement exists at all" gate
 * lower-level helpers (like requiring existence before a 404 check) need.
 */
export async function userCanAccessProject(userId: string, projectId: string): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { workspaceId: true, clientId: true },
  });
  if (!project) return false;

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  if (workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN") return true;

  const builtinMembership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  });
  if (builtinMembership) return true;

  const customRoleMembership = await db.query.projectCustomRoleMembers.findFirst({
    where: and(eq(projectCustomRoleMembers.projectId, projectId), eq(projectCustomRoleMembers.userId, userId)),
  });
  if (customRoleMembership) return true;

  if (project.clientId) {
    const clientMembership = await db.query.clientMembers.findFirst({
      where: and(eq(clientMembers.clientId, project.clientId), eq(clientMembers.userId, userId)),
    });
    if (clientMembership) return true;
  }

  return false;
}
