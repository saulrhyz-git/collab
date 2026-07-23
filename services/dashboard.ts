import { eq, inArray, desc } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, users, activityLogs } from "../db/schema";
import { listProjectsForWorkspace } from "./projects";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the post-login landing page needs, in one call, so the
 * dashboard never has to fire five separate requests (and risk five
 * separate loading-spinner flashes) just to answer "what's going on."
 *
 * Reuses listProjectsForWorkspace for the visible-project set (and its
 * NotAuthorizedError if the caller isn't a member) rather than
 * re-implementing the PUBLIC_TO_WORKSPACE / project-membership visibility
 * split here — same rule, one place.
 */
export async function getWorkspaceDashboard(workspaceId: string, userId: string) {
  const visibleProjects = await listProjectsForWorkspace(workspaceId, userId);
  const projectIds = visibleProjects.map((p) => p.id);
  const projectById = new Map(visibleProjects.map((p) => [p.id, p]));

  const taskRows = projectIds.length
    ? await db
        .select({
          id: tasks.id,
          projectId: tasks.projectId,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          dueDate: tasks.dueDate,
          assigneeId: tasks.assigneeId,
          assigneeName: users.fullName,
          assigneeAvatar: users.avatarUrl,
        })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assigneeId))
        .where(inArray(tasks.projectId, projectIds))
    : [];

  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * DAY_MS);
  const twoWeeksOut = new Date(now.getTime() + 14 * DAY_MS);
  const isOpen = (status: string) => status !== "DONE" && status !== "ARCHIVED";

  // --- Per-project task counts, for progress bars on the client/engagement list ---
  const countsByProject = new Map<string, { total: number; done: number; overdue: number }>();
  for (const t of taskRows) {
    const c = countsByProject.get(t.projectId) ?? { total: 0, done: 0, overdue: 0 };
    c.total += 1;
    if (t.status === "DONE") c.done += 1;
    if (t.dueDate && t.dueDate < now && isOpen(t.status)) c.overdue += 1;
    countsByProject.set(t.projectId, c);
  }

  // --- My tasks: everything assigned to me across every visible project, soonest due date first ---
  const myTasks = taskRows
    .filter((t) => t.assigneeId === userId && isOpen(t.status))
    .sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity))
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      projectId: t.projectId,
      projectName: projectById.get(t.projectId)?.name ?? "Unknown project",
    }));

  const myOpenTaskCount = taskRows.filter((t) => t.assigneeId === userId && isOpen(t.status)).length;
  const overdueCount = taskRows.filter(
    (t) => t.assigneeId === userId && t.dueDate && t.dueDate < now && isOpen(t.status)
  ).length;
  const dueThisWeekCount = taskRows.filter(
    (t) => t.assigneeId === userId && t.dueDate && t.dueDate >= now && t.dueDate <= weekOut && isOpen(t.status)
  ).length;

  // --- Upcoming deadlines: anyone's, across the whole workspace, next 14 days ---
  const upcomingDeadlines = taskRows
    .filter((t) => t.dueDate && t.dueDate >= now && t.dueDate <= twoWeeksOut && isOpen(t.status))
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      projectId: t.projectId,
      projectName: projectById.get(t.projectId)?.name ?? "Unknown project",
      assignee: t.assigneeId ? { id: t.assigneeId, fullName: t.assigneeName!, avatarUrl: t.assigneeAvatar } : null,
    }));

  // --- Recent activity: fetch a bit more than we show, then drop anything tied to a project the caller can't see ---
  const rawActivity = await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      metadata: activityLogs.metadata,
      timestamp: activityLogs.timestamp,
      projectId: activityLogs.projectId,
      actorId: activityLogs.userId,
      actorName: users.fullName,
    })
    .from(activityLogs)
    .leftJoin(users, eq(users.id, activityLogs.userId))
    .where(eq(activityLogs.workspaceId, workspaceId))
    .orderBy(desc(activityLogs.timestamp))
    .limit(30);

  const recentActivity = rawActivity
    .filter((a) => !a.projectId || projectById.has(a.projectId))
    .slice(0, 10)
    .map((a) => ({
      id: a.id,
      action: a.action,
      metadata: a.metadata as Record<string, unknown>,
      timestamp: a.timestamp,
      actorName: a.actorName ?? "Someone",
      projectName: a.projectId ? projectById.get(a.projectId)?.name ?? null : null,
    }));

  // --- Engagements grouped by client, plus a bucket for client-less (internal) projects ---
  const byClient = new Map<string, { id: string; name: string; projects: typeof visibleProjects }>();
  const unclientedProjects: typeof visibleProjects = [];
  for (const p of visibleProjects) {
    if (p.client) {
      const bucket = byClient.get(p.client.id) ?? { id: p.client.id, name: p.client.name, projects: [] };
      bucket.projects.push(p);
      byClient.set(p.client.id, bucket);
    } else {
      unclientedProjects.push(p);
    }
  }

  const clientsView = Array.from(byClient.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      projects: c.projects.map((p) => ({
        id: p.id,
        name: p.name,
        visibility: p.visibility,
        ...(countsByProject.get(p.id) ?? { total: 0, done: 0, overdue: 0 }),
      })),
    }));

  return {
    stats: {
      activeEngagements: visibleProjects.length,
      myOpenTasks: myOpenTaskCount,
      dueThisWeek: dueThisWeekCount,
      overdue: overdueCount,
    },
    myTasks,
    upcomingDeadlines,
    recentActivity,
    clients: clientsView,
    unclientedProjects: unclientedProjects.map((p) => ({
      id: p.id,
      name: p.name,
      visibility: p.visibility,
      ...(countsByProject.get(p.id) ?? { total: 0, done: 0, overdue: 0 }),
    })),
  };
}
