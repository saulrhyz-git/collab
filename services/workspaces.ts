import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { workspaces, workspaceMembers, activityLogs } from "../db/schema";

export class NotFoundError extends Error {}

export interface WorkspaceSummary {
  id: string;
  name: string;
  type: "PERSONAL" | "SHARED";
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
}

/** All workspaces the user belongs to, personal workspace included, for the switcher UI. */
export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      type: workspaces.type,
      role: workspaceMembers.role,
      scopedToProjectId: workspaceMembers.isProjectScopedGuest,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));

  // Project-scoped guest rows (workspace_members.scoped_to_project_id set)
  // grant no visibility into the rest of the workspace — they exist purely
  // so the FK chain from project_members resolves. Filter them out here so
  // a project-only guest never sees a phantom "workspace" entry in the
  // switcher; they access their project directly via its URL instead.
  return rows
    .filter((r) => r.scopedToProjectId === null)
    .map(({ id, name, type, role }) => ({ id, name, type, role }));
}

export async function createSharedWorkspace(params: { ownerId: string; name: string }) {
  const name = params.name.trim();
  if (!name) throw new Error("Workspace name is required.");

  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({ name, type: "SHARED", ownerId: params.ownerId })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: params.ownerId,
      role: "OWNER",
    });

    await tx.insert(activityLogs).values({
      workspaceId: ws.id,
      userId: params.ownerId,
      action: "workspace.created",
      metadata: { type: "SHARED" },
    });

    return ws;
  });
}

export async function getWorkspaceOrThrow(workspaceId: string) {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) throw new NotFoundError("Workspace not found.");
  return ws;
}
