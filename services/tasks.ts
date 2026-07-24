import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  tasks,
  projects,
  projectMembers,
  users,
  taskDependencies,
  activityLogs,
} from "../db/schema";
import { userCanAccessProject, userCanPerformOnProject } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "ARCHIVED";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

async function getProjectOrThrow(projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");
  return project;
}

/**
 * Exported so services/task-comments.ts, task-dependencies.ts, and
 * project-files.ts can reuse the same base access rule. Mirrors
 * can_access_project() in db/rls-policies.sql (PART 2) via
 * userCanAccessProject() — workspace owner/admin, a direct project_members
 * row, a project-scoped custom role, or a client-scoped custom role on the
 * project's client. Just a visibility gate; a *specific* action still needs
 * its own canPerform() check below (a task_members-only grant, for
 * instance, passes canPerform for its one task but not this project-wide
 * check — see each caller for how that's layered in).
 */
export async function requireProjectAccess(projectId: string, _workspaceId: string, userId: string): Promise<void> {
  if (!(await userCanAccessProject(userId, projectId))) {
    throw new NotAuthorizedError("You don't have access to this project.");
  }
}

/**
 * Matrix-governed permission check for a specific aspect action (e.g.
 * 'tasks.edit', 'comments.delete') — replaces the old single-flag
 * canWrite()/'task.write' check. Delegates to
 * services/permissions.ts's userCanPerformOnProject(), which (unlike the
 * old role-string comparison this replaces) also recognizes access granted
 * purely through a custom role or a client-wide grant, not just a built-in
 * project_members role.
 */
export async function canPerform(userId: string, projectId: string, key: string): Promise<boolean> {
  return userCanPerformOnProject(userId, projectId, key);
}

/**
 * Board/List/Gantt all consume this same shape — the view components decide
 * how to group/render it, not the service. startDate/parentTaskId are what
 * the Gantt and List views group and position by; Board ignores them.
 */
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
      startDate: tasks.startDate,
      dueDate: tasks.dueDate,
      parentTaskId: tasks.parentTaskId,
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
    startDate: r.startDate,
    dueDate: r.dueDate,
    parentTaskId: r.parentTaskId,
    assignee: r.assigneeId
      ? { id: r.assigneeId, fullName: r.assigneeName!, avatarUrl: r.assigneeAvatar }
      : null,
  }));
}

/** Predecessor/successor pairs for every task in a project — the Gantt view draws one line per row. */
export async function listProjectDependencies(projectId: string, userId: string) {
  const project = await getProjectOrThrow(projectId);
  await requireProjectAccess(projectId, project.workspaceId, userId);

  return db
    .select({
      id: taskDependencies.id,
      predecessorTaskId: taskDependencies.predecessorTaskId,
      successorTaskId: taskDependencies.successorTaskId,
      type: taskDependencies.type,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.successorTaskId))
    .where(eq(tasks.projectId, projectId));
}

export async function createTask(params: {
  projectId: string;
  reporterId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigneeId?: string | null;
  parentTaskId?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  /** Which column a board quick-add landed in — defaults to BACKLOG (List view's quick-add, and anyone not on the board). */
  status?: TaskStatus;
}) {
  const project = await getProjectOrThrow(params.projectId);
  if (!(await canPerform(params.reporterId, params.projectId, "tasks.create"))) {
    throw new NotAuthorizedError("You don't have permission to create tasks in this engagement.");
  }

  if (params.assigneeId) {
    const assigneeIsMember = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, params.projectId), eq(projectMembers.userId, params.assigneeId)),
    });
    if (!assigneeIsMember) {
      throw new NotAuthorizedError("Assignee must be a member of the project.");
    }
  }

  if (params.parentTaskId) {
    const parent = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, params.parentTaskId), eq(tasks.projectId, params.projectId)),
    });
    if (!parent) throw new NotFoundError("Parent task not found in this project.");
    if (parent.parentTaskId) {
      throw new NotAuthorizedError("Subtasks can't themselves have subtasks — only one level of nesting is supported.");
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
      status: params.status ?? "BACKLOG",
      priority: params.priority ?? "MEDIUM",
      assigneeId: params.assigneeId ?? null,
      parentTaskId: params.parentTaskId ?? null,
      reporterId: params.reporterId,
      startDate: params.startDate ?? null,
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
  if (!(await canPerform(params.actingUserId, params.projectId, "tasks.edit"))) {
    throw new NotAuthorizedError("You don't have permission to move tasks in this engagement.");
  }

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

/**
 * Full detail view for the task panel — the single call that hydrates
 * everything TaskDetailPanel.tsx renders: the task itself, assignee/reporter,
 * subtasks, and dependency edges (comments are fetched separately since
 * they're the one thing likely to be paginated/streamed later).
 */
export async function getTaskDetail(taskId: string, userId: string) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found.");

  await requireProjectAccess(task.projectId, task.workspaceId, userId);

  const [assignee, reporter, subtasks] = await Promise.all([
    task.assigneeId
      ? db.query.users.findFirst({
          where: eq(users.id, task.assigneeId),
          columns: { id: true, fullName: true, avatarUrl: true },
        })
      : Promise.resolve(null),
    db.query.users.findFirst({
      where: eq(users.id, task.reporterId),
      columns: { id: true, fullName: true, avatarUrl: true },
    }),
    db.query.tasks.findMany({
      where: eq(tasks.parentTaskId, taskId),
      columns: { id: true, title: true, status: true },
      orderBy: (t, { asc }) => [asc(t.position)],
    }),
  ]);

  // Fetched separately (not part of the Promise.all above) since each needs
  // a join in a different direction — "what's blocking me" vs "what am I
  // blocking" are mirror-image queries, not parallelizable with the rest
  // without duplicating the join logic.
  const blockedByRows = await db
    .select({ id: taskDependencies.id, type: taskDependencies.type, taskId: taskDependencies.predecessorTaskId, title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorTaskId))
    .where(eq(taskDependencies.successorTaskId, taskId));

  const blocksRows = await db
    .select({ id: taskDependencies.id, type: taskDependencies.type, taskId: taskDependencies.successorTaskId, title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.successorTaskId))
    .where(eq(taskDependencies.predecessorTaskId, taskId));

  return {
    ...task,
    assignee,
    reporter,
    subtasks,
    blockedBy: blockedByRows,
    blocks: blocksRows,
  };
}

export async function updateTask(params: {
  taskId: string;
  actingUserId: string;
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  assigneeId?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
}) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new NotFoundError("Task not found.");

  if (!(await canPerform(params.actingUserId, task.projectId, "tasks.edit"))) {
    throw new NotAuthorizedError("You don't have permission to edit tasks in this engagement.");
  }

  if (params.assigneeId) {
    const assigneeIsMember = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, params.assigneeId)),
    });
    if (!assigneeIsMember) throw new NotAuthorizedError("Assignee must be a member of the project.");
  }

  if (params.startDate && params.dueDate && params.startDate > params.dueDate) {
    throw new Error("Start date can't be after the due date.");
  }

  const [updated] = await db
    .update(tasks)
    .set({
      ...(params.title !== undefined ? { title: params.title.trim() } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.assigneeId !== undefined ? { assigneeId: params.assigneeId } : {}),
      ...(params.startDate !== undefined ? { startDate: params.startDate } : {}),
      ...(params.dueDate !== undefined ? { dueDate: params.dueDate } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, params.taskId))
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    userId: params.actingUserId,
    action: "task.updated",
    metadata: { taskId: task.id, fields: Object.keys(params).filter((k) => k !== "taskId" && k !== "actingUserId") },
  });

  return updated;
}
