import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, projects, projectMembers, workspaceMembers, users, activityLogs } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "ARCHIVED";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

async function getProjectOrThrow(projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");
  return project;
}

async function requireProjectAccess(projectId: string, workspaceId: string, userId: string) {
  const projectMembership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  });
  if (projectMembership) return projectMembership.role;

  // Full read/write access to every project, membership row or not.
  if (await isSuperAdmin(userId)) return "PROJECT_ADMIN" as const;

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (project?.visibility === "PUBLIC_TO_WORKSPACE") {
    const wm = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    });
    if (wm) return "VIEWER" as const; // workspace members get read access to public projects
  }
  throw new NotAuthorizedError("You don't have access to this project.");
}

function canWrite(role: string | undefined) {
  return role === "PROJECT_ADMIN" || role === "EDITOR";
}

export async function listProjectTasks(projectId: string, userId: string) {
  const project = await getProjectOrThrow(projectId);
  await requireProjectAccess(projectId, project.workspaceId, userId);

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      position: tasks.position,
      dueDate: tasks.dueDate,
      assigneeId: tasks.assigneeId,
      assigneeName: users.fullName,
      assigneeAvatar: users.avatarUrl,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(eq(tasks.projectId, projectId));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    position: r.position,
    dueDate: r.dueDate,
    assignee: r.assigneeId
      ? { id: r.assigneeId, fullName: r.assigneeName!, avatarUrl: r.assigneeAvatar }
      : null,
  }));
}

export async function createTask(params: {
  projectId: string;
  reporterId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: Date | null;
}) {
  const project = await getProjectOrThrow(params.projectId);
  const role = await requireProjectAccess(params.projectId, project.workspaceId, params.reporterId);
  if (!canWrite(role)) throw new NotAuthorizedError("Viewers cannot create tasks.");

  if (params.assigneeId) {
    const assigneeIsMember = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, params.projectId), eq(projectMembers.userId, params.assigneeId)),
    });
    if (!assigneeIsMember) {
      throw new NotAuthorizedError("Assignee must be a member of the project.");
    }
  }

  // New tasks land at the top of BACKLOG; position is well below the
  // current minimum so it doesn't need to look up existing rows.
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: params.projectId,
      workspaceId: project.workspaceId,
      title: params.title.trim(),
      description: params.description,
      status: "BACKLOG",
      priority: params.priority ?? "MEDIUM",
      assigneeId: params.assigneeId ?? null,
      reporterId: params.reporterId,
      dueDate: params.dueDate ?? null,
      position: Date.now() * -1,
    })
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: project.workspaceId,
    projectId: params.projectId,
    userId: params.reporterId,
    action: "task.created",
    metadata: { taskId: task.id, title: task.title },
  });

  return task;
}

export async function moveTask(params: {
  projectId: string;
  taskId: string;
  actingUserId: string;
  status: TaskStatus;
  position: number;
}) {
  const project = await getProjectOrThrow(params.projectId);
  const role = await requireProjectAccess(params.projectId, project.workspaceId, params.actingUserId);
  if (!canWrite(role)) throw new NotAuthorizedError("Viewers cannot move tasks.");

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, params.taskId), eq(tasks.projectId, params.projectId)),
  });
  if (!task) throw new NotFoundError("Task not found in this project.");

  const [updated] = await db
    .update(tasks)
    .set({ status: params.status, position: params.position, updatedAt: new Date() })
    .where(eq(tasks.id, params.taskId))
    .returning();

  if (task.status !== params.status) {
    await db.insert(activityLogs).values({
      workspaceId: project.workspaceId,
      projectId: params.projectId,
      userId: params.actingUserId,
      action: "task.status_changed",
      metadata: { taskId: task.id, from: task.status, to: params.status },
    });
  }

  return updated;
}
