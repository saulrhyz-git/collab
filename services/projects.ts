import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { projects, projectMembers, workspaceMembers, activityLogs, clients } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { userHasWorkspacePermission, userHasProjectPermission } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

type ProjectVisibility = "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS";

async function isWorkspaceMember(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return !!m;
}

/** Structural bypass mirroring RLS's is_workspace_admin() — OWNER/ADMIN role or super admin, NOT matrix-governed. */
async function isWorkspaceAdminRole(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

/**
 * Creates a project in the given workspace. The creator is automatically
 * added as PROJECT_ADMIN — otherwise nobody could manage the project they
 * just made (workspace membership alone doesn't imply project membership
 * for PRIVATE_TO_MEMBERS projects).
 *
 * Insert order note: `projects_select`'s policy (`can_access_project`)
 * requires either a PUBLIC_TO_WORKSPACE visibility or an existing
 * `project_members` row — neither is true yet at the instant the project
 * is inserted (the default is PRIVATE_TO_MEMBERS, and the creator's own
 * PROJECT_ADMIN membership row is the very next statement). Postgres
 * re-checks a table's SELECT policy against an INSERT's `.returning()`
 * output, so doing that here would fail with "new row violates row-level
 * security policy" for the default (private) case. Same fix as
 * services/workspaces.ts: pre-generate the id, insert without
 * `.returning()`, insert the membership row, then plain-SELECT it back.
 */
export async function createProject(params: {
  workspaceId: string;
  createdBy: string;
  name: string;
  description?: string;
  visibility?: ProjectVisibility;
  clientId?: string | null;
}) {
  const name = params.name.trim();
  if (!name) throw new Error("Project name is required.");

  const creatorRole = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, params.workspaceId), eq(workspaceMembers.userId, params.createdBy)),
  });
  if (!(await userHasWorkspacePermission(creatorRole?.role, params.createdBy, "project.create"))) {
    throw new NotAuthorizedError("You must be a member of this workspace to create a project in it.");
  }

  if (params.clientId) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, params.clientId) });
    if (!client || client.workspaceId !== params.workspaceId) {
      throw new NotFoundError("Client not found in this workspace.");
    }
  }

  return db.transaction(async (tx) => {
    const projectId = randomUUID();
    await tx.insert(projects).values({
      id: projectId,
      workspaceId: params.workspaceId,
      name,
      description: params.description,
      visibility: params.visibility ?? "PRIVATE_TO_MEMBERS",
      createdBy: params.createdBy,
      clientId: params.clientId ?? null,
    });

    await tx.insert(projectMembers).values({
      projectId,
      userId: params.createdBy,
      role: "PROJECT_ADMIN",
    });

    await tx.insert(activityLogs).values({
      workspaceId: params.workspaceId,
      projectId,
      userId: params.createdBy,
      action: "project.created",
      metadata: { name },
    });

    const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
    return project!;
  });
}

/**
 * Lists non-archived projects in a workspace that the requester can see —
 * PUBLIC_TO_WORKSPACE projects show up for any workspace member,
 * PRIVATE_TO_MEMBERS ones only if they're an explicit project member.
 * RLS enforces the same split independently (can_access_project()).
 */
export async function listProjectsForWorkspace(workspaceId: string, requestingUserId: string) {
  if (!(await isWorkspaceMember(workspaceId, requestingUserId))) {
    throw new NotAuthorizedError("You are not a member of this workspace.");
  }

  const allProjects = await db.query.projects.findMany({
    where: and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)),
    orderBy: (p, { desc }) => [desc(p.createdAt)],
    with: { client: { columns: { id: true, name: true } } },
  });

  const isSuper = await isSuperAdmin(requestingUserId);
  if (isSuper) return allProjects;

  const memberships = await db.query.projectMembers.findMany({
    where: eq(projectMembers.userId, requestingUserId),
    columns: { projectId: true },
  });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  return allProjects.filter(
    (p) => p.visibility === "PUBLIC_TO_WORKSPACE" || memberProjectIds.has(p.id)
  );
}

export async function getProject(projectId: string, requestingUserId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");

  if (await isSuperAdmin(requestingUserId)) return project;

  const membership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, requestingUserId)),
  });
  if (membership) return project;

  if (project.visibility === "PUBLIC_TO_WORKSPACE" && (await isWorkspaceMember(project.workspaceId, requestingUserId))) {
    return project;
  }

  throw new NotAuthorizedError("You don't have access to this project.");
}

export async function updateProject(params: {
  projectId: string;
  actingUserId: string;
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  clientId?: string | null;
}) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, params.projectId) });
  if (!project) throw new NotFoundError("Project not found.");

  // Mirrors projects_update RLS exactly: is_workspace_admin(workspace_id) OR
  // has_workspace_permission(workspace_id, 'project.manage') OR
  // has_project_permission(id, 'project.edit'). The first is a structural
  // bypass; the latter two are matrix-governed (services/permissions.ts).
  const isWorkspaceAdmin = await isWorkspaceAdminRole(project.workspaceId, params.actingUserId);
  if (!isWorkspaceAdmin) {
    const workspaceMembership = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, params.actingUserId)),
    });
    const canManageWorkspaceProjects = await userHasWorkspacePermission(
      workspaceMembership?.role,
      params.actingUserId,
      "project.manage"
    );
    if (!canManageWorkspaceProjects) {
      const membership = await db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.projectId, params.projectId), eq(projectMembers.userId, params.actingUserId)),
      });
      const canEditProject = await userHasProjectPermission(membership?.role, params.actingUserId, "project.edit");
      if (!canEditProject) {
        throw new NotAuthorizedError("Only a project admin or workspace admin can edit this project.");
      }
    }
  }

  const [updated] = await db
    .update(projects)
    .set({
      ...(params.name !== undefined ? { name: params.name.trim() } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
      ...(params.clientId !== undefined ? { clientId: params.clientId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, params.projectId))
    .returning();

  return updated;
}

/** Soft-delete — archives rather than drops, so tasks/history aren't lost. */
export async function archiveProject(projectId: string, actingUserId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");

  // Mirrors projects_delete RLS: is_workspace_admin(workspace_id) OR
  // has_workspace_permission(workspace_id, 'project.manage').
  if (!(await isWorkspaceAdminRole(project.workspaceId, actingUserId))) {
    const workspaceMembership = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, actingUserId)),
    });
    const canManage = await userHasWorkspacePermission(workspaceMembership?.role, actingUserId, "project.manage");
    if (!canManage) {
      throw new NotAuthorizedError("Only a workspace admin can archive a project.");
    }
  }

  await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
  await db.insert(activityLogs).values({
    workspaceId: project.workspaceId,
    projectId,
    userId: actingUserId,
    action: "project.archived",
    metadata: {},
  });
}
