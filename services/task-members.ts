/**
 * task_members — true task-level access: grant one person VIEWER or EDITOR
 * on exactly one task, without any visibility into the rest of the
 * engagement's backlog. Direct (non-invite) grants for users who already
 * have an account; services/task-invitations.ts handles inviting by email.
 *
 * Mirrors task_members_insert/_select/_delete RLS in db/rls-policies.sql
 * (PART 2) — consolidated onto a single check: can_perform_on_project(...,
 * 'tasks.edit'), which itself already includes the workspace-admin bypass.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { taskMembers, tasks, workspaceMembers, users, activityLogs } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { userCanPerformOnProject } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

type TaskMemberRole = "VIEWER" | "EDITOR";

async function getTaskOrThrow(taskId: string) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found.");
  return task;
}

async function isWorkspaceAdmin(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

/**
 * Anyone who could already edit tasks in the project (or the workspace
 * admin) can hand out a narrow one-task grant — sharing a single task is a
 * lighter-weight action than full task-editing, so it doesn't need its own
 * matrix entry.
 */
async function assertCanManageTaskMembers(task: { projectId: string; workspaceId: string }, actingUserId: string) {
  if (await isWorkspaceAdmin(task.workspaceId, actingUserId)) return;
  if (await userCanPerformOnProject(actingUserId, task.projectId, "tasks.edit")) return;
  throw new NotAuthorizedError("You don't have permission to share this task.");
}

export async function listTaskMembers(taskId: string, requestingUserId: string) {
  const task = await getTaskOrThrow(taskId);
  const isSelf = await db.query.taskMembers.findFirst({
    where: and(eq(taskMembers.taskId, taskId), eq(taskMembers.userId, requestingUserId)),
  });
  if (!isSelf) {
    await assertCanManageTaskMembers(task, requestingUserId);
  }

  return db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      role: taskMembers.role,
      createdAt: taskMembers.createdAt,
    })
    .from(taskMembers)
    .innerJoin(users, eq(users.id, taskMembers.userId))
    .where(eq(taskMembers.taskId, taskId));
}

export async function addTaskMember(params: {
  taskId: string;
  targetUserId: string;
  role: TaskMemberRole;
  actingUserId: string;
}) {
  const task = await getTaskOrThrow(params.taskId);
  await assertCanManageTaskMembers(task, params.actingUserId);

  const target = await db.query.users.findFirst({ where: eq(users.id, params.targetUserId) });
  if (!target) throw new NotFoundError("User not found.");

  await db
    .insert(taskMembers)
    .values({
      taskId: params.taskId,
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      userId: params.targetUserId,
      role: params.role,
      invitedBy: params.actingUserId,
    })
    .onConflictDoUpdate({
      target: [taskMembers.taskId, taskMembers.userId],
      set: { role: params.role },
    });

  await db.insert(activityLogs).values({
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    userId: params.actingUserId,
    action: "task_member.added",
    metadata: { taskId: params.taskId, targetUserId: params.targetUserId, role: params.role },
  });
}

export async function removeTaskMember(params: { taskId: string; targetUserId: string; actingUserId: string }) {
  const task = await getTaskOrThrow(params.taskId);

  if (params.actingUserId !== params.targetUserId) {
    await assertCanManageTaskMembers(task, params.actingUserId);
  }

  await db
    .delete(taskMembers)
    .where(and(eq(taskMembers.taskId, params.taskId), eq(taskMembers.userId, params.targetUserId)));

  await db.insert(activityLogs).values({
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    userId: params.actingUserId,
    action: "task_member.removed",
    metadata: { taskId: params.taskId, targetUserId: params.targetUserId },
  });
}
