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
import { permissions, rolePermissions } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}

type Scope = "WORKSPACE" | "PROJECT";

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
 */
export async function getPermissionMatrix() {
  const [catalog, grants] = await Promise.all([
    db.query.permissions.findMany({ orderBy: (p, { asc }) => [asc(p.scope), asc(p.key)] }),
    db.query.rolePermissions.findMany(),
  ]);

  const grantMap = new Map(grants.map((g) => [`${g.scope}:${g.role}:${g.permissionKey}`, g.granted]));
  const rolesByScope: Record<Scope, string[]> = {
    WORKSPACE: ["OWNER", "ADMIN", "MEMBER", "GUEST"],
    PROJECT: ["PROJECT_ADMIN", "EDITOR", "VIEWER"],
  };

  return catalog.map((p) => ({
    key: p.key,
    label: p.label,
    scope: p.scope as Scope,
    description: p.description,
    roles: rolesByScope[p.scope as Scope].map((role) => ({
      role,
      granted: grantMap.get(`${p.scope}:${role}:${p.key}`) ?? false,
    })),
  }));
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
