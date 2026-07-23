import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { workspaces, workspaceMembers, activityLogs } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotFoundError extends Error {}

export interface WorkspaceSummary {
  id: string;
  name: string;
  type: "PERSONAL" | "SHARED";
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
}

/** All workspaces the user belongs to, personal workspace included, for the switcher UI. */
export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  if (await isSuperAdmin(userId)) {
    // Every workspace in the system, not just ones they've joined — that's
    // the point of "platform-wide". Report their real role where they
    // happen to also be an actual member (so their own personal workspace
    // still shows OWNER), and a synthetic "ADMIN" everywhere else.
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        type: workspaces.type,
        role: workspaceMembers.role,
      })
      .from(workspaces)
      .leftJoin(
        workspaceMembers,
        and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId))
      );
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, role: r.role ?? "ADMIN" }));
  }

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

/**
 * Note on the insert order below: `workspaces_select`'s RLS policy requires
 * `is_workspace_member(id)`, which is false until the OWNER membership row
 * exists — and Postgres re-checks a table's SELECT policy against whatever
 * an INSERT/UPDATE `.returning()`s. Asking for the new workspace back in
 * the same statement that creates it would fail with "new row violates
 * row-level security policy" for every ordinary (non-super-admin) caller.
 * So: generate the id up front, insert without `.returning()`, insert the
 * membership row, then plain-SELECT the workspace — which passes the
 * policy fine now that the membership row backing it exists.
 */
export async function createSharedWorkspace(params: { ownerId: string; name: string }) {
  const name = params.name.trim();
  if (!name) throw new Error("Workspace name is required.");

  return db.transaction(async (tx) => {
    const workspaceId = randomUUID();
    await tx.insert(workspaces).values({ id: workspaceId, name, type: "SHARED", ownerId: params.ownerId });

    await tx.insert(workspaceMembers).values({
      workspaceId,
      userId: params.ownerId,
      role: "OWNER",
    });

    await tx.insert(activityLogs).values({
      workspaceId,
      userId: params.ownerId,
      action: "workspace.created",
      metadata: { type: "SHARED" },
    });

    const ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    return ws!;
  });
}

export async function getWorkspaceOrThrow(workspaceId: string) {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) throw new NotFoundError("Workspace not found.");
  return ws;
}
