/**
 * task_checklist_items — a lightweight punch-list inside a task (checkbox +
 * title + optional remarks), distinct from services/tasks.ts's own
 * parent/child subtask relationship. Mirrors task_checklist_items RLS in
 * db/rls-policies.sql exactly: read requires task-level visibility
 * (task_members grant or project-level tasks.view); every write (add,
 * toggle, edit, delete) is gated by a single tasks.edit check, same bar as
 * editing the task's own title/description.
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client";
import { taskChecklistItems, tasks } from "../db/schema";
import { requireProjectAccess, canPerform, NotFoundError, NotAuthorizedError } from "./tasks";

export { NotFoundError, NotAuthorizedError };

async function getTaskOrThrow(taskId: string) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found.");
  return task;
}

async function assertCanEditChecklist(task: { projectId: string; workspaceId: string }, actingUserId: string) {
  if (!(await canPerform(actingUserId, task.projectId, "tasks.edit"))) {
    throw new NotAuthorizedError("You don't have permission to edit this task's checklist.");
  }
}

export async function listChecklistItems(taskId: string, userId: string) {
  const task = await getTaskOrThrow(taskId);
  await requireProjectAccess(task.projectId, task.workspaceId, userId); // any project role, including VIEWER, can read

  return db.query.taskChecklistItems.findMany({
    where: eq(taskChecklistItems.taskId, taskId),
    orderBy: (c, { asc }) => [asc(c.position)],
  });
}

export async function addChecklistItem(params: {
  taskId: string;
  title: string;
  remarks?: string | null;
  actingUserId: string;
}) {
  const title = params.title.trim();
  if (!title) throw new Error("Checklist item title can't be empty.");

  const task = await getTaskOrThrow(params.taskId);
  await assertCanEditChecklist(task, params.actingUserId);

  // Append to the end — fetch the current max position rather than a plain
  // count, since items can be deleted out of order and a count would then
  // collide with an existing position.
  const [{ maxPosition }] = await db
    .select({ maxPosition: sql<number>`coalesce(max(${taskChecklistItems.position}), 0)` })
    .from(taskChecklistItems)
    .where(eq(taskChecklistItems.taskId, params.taskId));

  const [item] = await db
    .insert(taskChecklistItems)
    .values({
      taskId: params.taskId,
      title,
      remarks: params.remarks ?? null,
      position: maxPosition + 1000,
      createdBy: params.actingUserId,
    })
    .returning();

  return item;
}

export async function updateChecklistItem(params: {
  itemId: string;
  actingUserId: string;
  title?: string;
  remarks?: string | null;
  completed?: boolean;
}) {
  const item = await db.query.taskChecklistItems.findFirst({ where: eq(taskChecklistItems.id, params.itemId) });
  if (!item) throw new NotFoundError("Checklist item not found.");

  const task = await getTaskOrThrow(item.taskId);
  await assertCanEditChecklist(task, params.actingUserId);

  if (params.title !== undefined && !params.title.trim()) {
    throw new Error("Checklist item title can't be empty.");
  }

  const [updated] = await db
    .update(taskChecklistItems)
    .set({
      ...(params.title !== undefined ? { title: params.title.trim() } : {}),
      ...(params.remarks !== undefined ? { remarks: params.remarks } : {}),
      ...(params.completed !== undefined ? { completed: params.completed } : {}),
      updatedAt: new Date(),
    })
    .where(eq(taskChecklistItems.id, params.itemId))
    .returning();

  return updated;
}

export async function deleteChecklistItem(params: { itemId: string; actingUserId: string }) {
  const item = await db.query.taskChecklistItems.findFirst({ where: eq(taskChecklistItems.id, params.itemId) });
  if (!item) throw new NotFoundError("Checklist item not found.");

  const task = await getTaskOrThrow(item.taskId);
  await assertCanEditChecklist(task, params.actingUserId);

  await db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, params.itemId));
}
