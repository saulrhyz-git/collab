/**
 * Workspace member removal — the messy edge case is what happens to that
 * user's assigned tasks. Policy implemented here (configurable per
 * workspace in a real product, hard-coded to the safer default below):
 *
 *   1. Tasks they were ASSIGNED remain in the project but assignee_id is
 *      cleared (set to null) rather than cascading a delete — work items
 *      must never silently disappear because someone left.
 *   2. Tasks they REPORTED keep reporter_id pointing at them (historical
 *      record) even though they can no longer be looked up via an active
 *      membership — reporter_id has ON DELETE SET NULL only if the user
 *      row itself is deleted, not on workspace removal.
 *   3. Their project_members rows for projects in this workspace are
 *      deleted (cascades from workspace removal cleanup below), which
 *      also drops them from any Kanban board's collaborator list.
 *   4. An activity_log entry captures who removed them and how many
 *      tasks were unassigned, so it's auditable and reversible by a re-invite.
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {
  workspaceMembers,
  projectMembers,
  projects,
  tasks,
  activityLogs,
} from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}
export class CannotRemoveOwnerError extends Error {}

export async function removeWorkspaceMember(params: {
  workspaceId: string;
  targetUserId: string;
  actingUserId: string;
}) {
  const { workspaceId, targetUserId, actingUserId } = params;

  const actingMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actingUserId)),
  });
  const isAdmin = actingMembership?.role === "OWNER" || actingMembership?.role === "ADMIN";
  if (!isAdmin && actingUserId !== targetUserId && !(await isSuperAdmin(actingUserId))) {
    throw new NotAuthorizedError("Only a workspace admin can remove other members.");
  }

  const targetMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)),
  });
  if (targetMembership?.role === "OWNER") {
    throw new CannotRemoveOwnerError(
      "The workspace owner can't be removed — transfer ownership first."
    );
  }

  await db.transaction(async (tx) => {
    const workspaceProjectIds = (
      await tx.query.projects.findMany({
        where: eq(projects.workspaceId, workspaceId),
        columns: { id: true },
      })
    ).map((p) => p.id);

    // 1. Unassign (not delete) tasks assigned to this user across every
    //    project in the workspace.
    const unassigned = await tx
      .update(tasks)
      .set({ assigneeId: null })
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.assigneeId, targetUserId)))
      .returning({ id: tasks.id });

    // 2. Drop their project-level memberships within this workspace.
    if (workspaceProjectIds.length > 0) {
      await tx
        .delete(projectMembers)
        .where(
          and(
            inArray(projectMembers.projectId, workspaceProjectIds),
            eq(projectMembers.userId, targetUserId)
          )
        );
    }

    // 3. Remove the workspace membership itself.
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)));

    // 4. Audit trail.
    await tx.insert(activityLogs).values({
      workspaceId,
      userId: actingUserId,
      action: "workspace_member.removed",
      metadata: { targetUserId, tasksUnassigned: unassigned.length },
    });
  });
}
