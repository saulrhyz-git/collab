/**
 * Custom roles — superadmin-created role *names* scoped CLIENT or PROJECT
 * (see db/schema.ts's customRoles comment). A custom role's actual grants
 * live in the SAME role_permissions matrix built-in roles use (role =
 * the custom role's id, cast to text) — editing them goes through
 * services/permissions.ts's setRolePermission, not this file. This file
 * only manages the role's identity (name/scope/description) and its
 * lifecycle; deleting a role cascades to client_members/
 * project_custom_role_members grants (FK onDelete: "cascade" in schema.ts)
 * and to any role_permissions rows referencing it (see deleteCustomRole).
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { customRoles, rolePermissions } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { invalidatePermissionsCache } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

type RoleScope = "PROJECT" | "CLIENT";

async function assertSuperAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) {
    throw new NotAuthorizedError("Only a super admin can manage custom roles.");
  }
}

/** Any authenticated user can list roles — invite pickers need this. */
export async function listCustomRoles(scope?: RoleScope) {
  return db.query.customRoles.findMany({
    where: scope ? eq(customRoles.scope, scope) : undefined,
    orderBy: (r, { asc }) => [asc(r.name)],
  });
}

export async function getCustomRole(customRoleId: string) {
  const role = await db.query.customRoles.findFirst({ where: eq(customRoles.id, customRoleId) });
  if (!role) throw new NotFoundError("Custom role not found.");
  return role;
}

export async function createCustomRole(params: {
  actingUserId: string;
  name: string;
  scope: RoleScope;
  description?: string;
}) {
  await assertSuperAdmin(params.actingUserId);

  const name = params.name.trim();
  if (!name) throw new ValidationError("Role name is required.");
  if (params.scope !== "PROJECT" && params.scope !== "CLIENT") {
    throw new ValidationError("Custom roles must be scoped PROJECT or CLIENT.");
  }

  const existing = await db.query.customRoles.findFirst({
    where: and(eq(customRoles.scope, params.scope), eq(customRoles.name, name)),
  });
  if (existing) throw new ValidationError(`A ${params.scope.toLowerCase()}-scoped role named "${name}" already exists.`);

  const [role] = await db
    .insert(customRoles)
    .values({ name, scope: params.scope, description: params.description, createdBy: params.actingUserId })
    .returning();
  return role;
}

export async function updateCustomRole(params: {
  customRoleId: string;
  actingUserId: string;
  name?: string;
  description?: string | null;
}) {
  await assertSuperAdmin(params.actingUserId);

  const existing = await getCustomRole(params.customRoleId);

  if (params.name !== undefined) {
    const name = params.name.trim();
    if (!name) throw new ValidationError("Role name is required.");
    const clash = await db.query.customRoles.findFirst({
      where: and(eq(customRoles.scope, existing.scope), eq(customRoles.name, name)),
    });
    if (clash && clash.id !== existing.id) {
      throw new ValidationError(`A ${existing.scope.toLowerCase()}-scoped role named "${name}" already exists.`);
    }
  }

  await db
    .update(customRoles)
    .set({
      ...(params.name !== undefined ? { name: params.name.trim() } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    })
    .where(eq(customRoles.id, params.customRoleId));

  return getCustomRole(params.customRoleId);
}

/**
 * Deleting a role cascades its actual grants (client_members /
 * project_custom_role_members rows) via the FK, per schema.ts — but
 * role_permissions has no FK to custom_roles (its `role` column is a plain
 * text field shared with built-in role names, so it can't carry one), so
 * the matrix tickboxes for this role are cleaned up explicitly here to
 * avoid leaving orphaned rows keyed by a now-deleted uuid.
 */
export async function deleteCustomRole(customRoleId: string, actingUserId: string) {
  await assertSuperAdmin(actingUserId);
  const existing = await getCustomRole(customRoleId);

  await db.transaction(async (tx) => {
    await tx
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.scope, existing.scope), eq(rolePermissions.role, customRoleId)));
    await tx.delete(customRoles).where(eq(customRoles.id, customRoleId));
  });

  invalidatePermissionsCache();
}
