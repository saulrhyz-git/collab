/**
 * project_custom_role_members — layers a superadmin-defined custom role's
 * permissions on top of (or instead of) a project member's built-in
 * PROJECT_ADMIN/EDITOR/VIEWER role, for one specific engagement. Additive by
 * design (see db/schema.ts's comment): granting/revoking a custom role here
 * never touches the underlying project_members row.
 *
 * Mirrors project_custom_role_members_insert/_delete RLS in db/rls-policies.sql:
 * can_perform_on_project(project, ..., 'members.edit') — includes the
 * workspace-admin bypass and recognizes custom-role/client-wide grants of
 * 'members.edit', not just the built-in PROJECT_ADMIN row.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  projectCustomRoleMembers,
  projectMembers,
  projects,
  workspaceMembers,
  customRoles,
  users,
  activityLogs,
} from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { userCanPerformOnProject } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

async function getProjectOrThrow(projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");
  return project;
}

async function isWorkspaceAdmin(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

async function assertCanManageMembers(projectId: string, workspaceId: string, actingUserId: string) {
  if (await isWorkspaceAdmin(workspaceId, actingUserId)) return;
  if (await userCanPerformOnProject(actingUserId, projectId, "members.edit")) return;
  throw new NotAuthorizedError("Only a project admin or workspace admin can manage members.");
}

export async function listProjectCustomRoleMembers(projectId: string, requestingUserId: string) {
  const project = await getProjectOrThrow(projectId);
  const requesterIsMember = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, requestingUserId)),
  });
  if (!requesterIsMember && !(await isWorkspaceAdmin(project.workspaceId, requestingUserId))) {
    throw new NotAuthorizedError("You are not a member of this project.");
  }

  return db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      customRoleId: customRoles.id,
      customRoleName: customRoles.name,
      createdAt: projectCustomRoleMembers.createdAt,
    })
    .from(projectCustomRoleMembers)
    .innerJoin(users, eq(users.id, projectCustomRoleMembers.userId))
    .innerJoin(customRoles, eq(customRoles.id, projectCustomRoleMembers.customRoleId))
    .where(eq(projectCustomRoleMembers.projectId, projectId));
}

/**
 * Grants a PROJECT-scoped custom role directly (no invite flow — the target
 * user must already be reachable, i.e. already a project_members row, OR
 * this call is itself part of accepting an invite that carries a
 * customRoleId; see services/invitations.ts's acceptProjectInvite).
 */
export async function grantProjectCustomRole(params: {
  projectId: string;
  targetUserId: string;
  customRoleId: string;
  actingUserId: string;
}) {
  const { projectId, targetUserId, customRoleId, actingUserId } = params;
  const project = await getProjectOrThrow(projectId);
  await assertCanManageMembers(projectId, project.workspaceId, actingUserId);

  const role = await db.query.customRoles.findFirst({ where: eq(customRoles.id, customRoleId) });
  if (!role) throw new NotFoundError("Custom role not found.");
  if (role.scope !== "PROJECT") {
    throw new ValidationError("Only PROJECT-scoped custom roles can be granted on an engagement directly.");
  }

  const alreadyMember = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)),
  });
  if (!alreadyMember) {
    throw new ValidationError("The user must already be a project member before granting a custom role.");
  }

  await db
    .insert(projectCustomRoleMembers)
    .values({ projectId, userId: targetUserId, customRoleId, invitedBy: actingUserId })
    .onConflictDoNothing();

  await db.insert(activityLogs).values({
    workspaceId: project.workspaceId,
    projectId,
    userId: actingUserId,
    action: "project_custom_role.granted",
    metadata: { targetUserId, customRoleId },
  });
}

export async function revokeProjectCustomRole(params: {
  projectId: string;
  targetUserId: string;
  customRoleId: string;
  actingUserId: string;
}) {
  const { projectId, targetUserId, customRoleId, actingUserId } = params;
  const project = await getProjectOrThrow(projectId);

  if (actingUserId !== targetUserId) {
    await assertCanManageMembers(projectId, project.workspaceId, actingUserId);
  }

  await db
    .delete(projectCustomRoleMembers)
    .where(
      and(
        eq(projectCustomRoleMembers.projectId, projectId),
        eq(projectCustomRoleMembers.userId, targetUserId),
        eq(projectCustomRoleMembers.customRoleId, customRoleId)
      )
    );

  await db.insert(activityLogs).values({
    workspaceId: project.workspaceId,
    projectId,
    userId: actingUserId,
    action: "project_custom_role.revoked",
    metadata: { targetUserId, customRoleId },
  });
}
