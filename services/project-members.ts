import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  projectMembers,
  projects,
  workspaceMembers,
  users,
  tasks,
  activityLogs,
} from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { userCanPerformOnProject } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}
export class CannotRemoveLastAdminError extends Error {}

type ProjectRole = "PROJECT_ADMIN" | "EDITOR" | "VIEWER";

async function getProjectOrThrow(projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");
  return project;
}

/** Structural bypass mirroring RLS's is_workspace_admin() — OWNER/ADMIN role or super admin, NOT matrix-governed. */
async function isWorkspaceAdmin(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

/**
 * Mirrors project_members_update/_delete RLS exactly (now split from the
 * old single 'project.manage_members' key): is_workspace_admin(workspace)
 * OR has_project_permission(project, 'members.edit'|'members.delete'),
 * plus recognizing custom roles and client-wide grants via
 * userCanPerformOnProject (which already includes the workspace-admin
 * bypass, so isWorkspaceAdmin is redundant here but kept for clarity/speed
 * on the common case).
 */
async function assertCanEditMembers(projectId: string, workspaceId: string, actingUserId: string) {
  if (await isWorkspaceAdmin(workspaceId, actingUserId)) return;
  if (await userCanPerformOnProject(actingUserId, projectId, "members.edit")) return;
  throw new NotAuthorizedError("Only a project admin or workspace admin can manage members.");
}

async function assertCanRemoveMembers(projectId: string, workspaceId: string, actingUserId: string) {
  if (await isWorkspaceAdmin(workspaceId, actingUserId)) return;
  if (await userCanPerformOnProject(actingUserId, projectId, "members.delete")) return;
  throw new NotAuthorizedError("Only a project admin or workspace admin can manage members.");
}

export async function listProjectMembers(projectId: string, requestingUserId: string) {
  const project = await getProjectOrThrow(projectId);

  // Any current member (any role) can view the roster; RLS backs this up
  // independently at the query layer.
  const requesterIsMember = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, requestingUserId)),
  });
  const requesterIsWorkspaceAdmin = await isWorkspaceAdmin(project.workspaceId, requestingUserId);
  if (!requesterIsMember && !requesterIsWorkspaceAdmin) {
    throw new NotAuthorizedError("You are not a member of this project.");
  }

  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      avatarUrl: users.avatarUrl,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));

  return rows;
}

export async function updateProjectMemberRole(params: {
  projectId: string;
  targetUserId: string;
  newRole: ProjectRole;
  actingUserId: string;
}) {
  const { projectId, targetUserId, newRole, actingUserId } = params;
  const project = await getProjectOrThrow(projectId);
  await assertCanEditMembers(projectId, project.workspaceId, actingUserId);

  const target = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)),
  });
  if (!target) throw new NotFoundError("This user is not a member of the project.");

  // Guard against demoting the last remaining PROJECT_ADMIN — a project
  // with zero admins can no longer have its membership managed at all.
  if (target.role === "PROJECT_ADMIN" && newRole !== "PROJECT_ADMIN") {
    const admins = await db.query.projectMembers.findMany({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "PROJECT_ADMIN")),
    });
    if (admins.length <= 1) {
      throw new CannotRemoveLastAdminError("A project must retain at least one admin.");
    }
  }

  await db
    .update(projectMembers)
    .set({ role: newRole })
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)));

  await db.insert(activityLogs).values({
    workspaceId: project.workspaceId,
    projectId,
    userId: actingUserId,
    action: "project_member.role_changed",
    metadata: { targetUserId, newRole, previousRole: target.role },
  });
}

export async function removeProjectMember(params: {
  projectId: string;
  targetUserId: string;
  actingUserId: string;
}) {
  const { projectId, targetUserId, actingUserId } = params;
  const project = await getProjectOrThrow(projectId);

  // A member may always remove themselves ("leave project") without
  // needing admin rights; removing someone else requires admin.
  if (actingUserId !== targetUserId) {
    await assertCanRemoveMembers(projectId, project.workspaceId, actingUserId);
  }

  const target = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)),
  });
  if (!target) throw new NotFoundError("This user is not a member of the project.");

  if (target.role === "PROJECT_ADMIN") {
    const admins = await db.query.projectMembers.findMany({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "PROJECT_ADMIN")),
    });
    if (admins.length <= 1) {
      throw new CannotRemoveLastAdminError(
        "Promote another member to admin before removing the last one."
      );
    }
  }

  await db.transaction(async (tx) => {
    // Unassign their tasks in this project rather than deleting them.
    const unassigned = await tx
      .update(tasks)
      .set({ assigneeId: null })
      .where(and(eq(tasks.projectId, projectId), eq(tasks.assigneeId, targetUserId)))
      .returning({ id: tasks.id });

    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)));

    await tx.insert(activityLogs).values({
      workspaceId: project.workspaceId,
      projectId,
      userId: actingUserId,
      action: "project_member.removed",
      metadata: { targetUserId, tasksUnassigned: unassigned.length },
    });
  });
}
