import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, taskComments, users, activityLogs } from "../db/schema";
import { requireProjectAccess, NotFoundError } from "./tasks";

export { NotFoundError };
export class NotAuthorizedError extends Error {}

export async function listComments(taskId: string, userId: string) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found.");
  await requireProjectAccess(task.projectId, task.workspaceId, userId); // any project role, including VIEWER, can read

  return db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      editedAt: taskComments.editedAt,
      authorId: taskComments.authorId,
      authorName: users.fullName,
      authorAvatar: users.avatarUrl,
    })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.authorId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt);
}

/** Commenting only requires project *access*, not edit rights — matches Asana/Linear (viewers can weigh in). */
export async function addComment(params: { taskId: string; authorId: string; body: string }) {
  const body = params.body.trim();
  if (!body) throw new Error("Comment can't be empty.");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new NotFoundError("Task not found.");
  await requireProjectAccess(task.projectId, task.workspaceId, params.authorId);

  const [comment] = await db
    .insert(taskComments)
    .values({ taskId: params.taskId, authorId: params.authorId, body })
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    userId: params.authorId,
    action: "task.commented",
    metadata: { taskId: task.id, commentId: comment.id },
  });

  return comment;
}

export async function deleteComment(params: { commentId: string; actingUserId: string }) {
  const comment = await db.query.taskComments.findFirst({ where: eq(taskComments.id, params.commentId) });
  if (!comment) throw new NotFoundError("Comment not found.");

  if (comment.authorId !== params.actingUserId) {
    // Workspace admins/super admins can moderate; requireProjectAccess
    // throwing here (non-member) is an acceptable side effect — it means
    // they also can't see the task, so deleting its comment is moot.
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, comment.taskId) });
    if (!task) throw new NotFoundError("Task not found.");
    const role = await requireProjectAccess(task.projectId, task.workspaceId, params.actingUserId);
    if (role !== "PROJECT_ADMIN") {
      throw new NotAuthorizedError("Only the comment's author or a project admin can delete it.");
    }
  }

  await db.delete(taskComments).where(eq(taskComments.id, params.commentId));
}
