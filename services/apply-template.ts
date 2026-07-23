/**
 * Applying a task template (or an engagement type's set of templates) to a
 * project — this is the "populate the backlog" action. Per the product
 * decision: building templates/engagement types stays superadmin-only
 * (see services/task-templates.ts, services/engagement-types.ts), but
 * *applying* an existing one is available to any project member who
 * already holds task-creation rights on that project — the same bar as
 * creating a single task by hand, since this is really just bulk task
 * creation. Mirrors project_engagement_type_write RLS exactly:
 * is_workspace_admin(workspace) OR can_perform_on_project(..., 'task.write').
 */

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, projects, activityLogs, taskTemplates, engagementTypes, projectEngagementType } from "../db/schema";
import { requireProjectAccess, canWrite, NotFoundError, NotAuthorizedError } from "./tasks";
import { getTaskTemplate } from "./task-templates";
import { getEngagementType } from "./engagement-types";

export { NotFoundError, NotAuthorizedError };

async function assertCanApply(projectId: string, actingUserId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");

  const role = await requireProjectAccess(projectId, project.workspaceId, actingUserId);
  if (!(await canWrite(role, actingUserId))) {
    throw new NotAuthorizedError("You don't have permission to create tasks in this engagement.");
  }
  return project;
}

/**
 * Inserts one template's items into a project's BACKLOG. `startBefore` lets
 * multiple templates get applied back-to-back (e.g. from an engagement
 * type) while still landing above whatever was already in the backlog and
 * in template-declared order.
 */
async function insertTemplateItems(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectId: string,
  workspaceId: string,
  reporterId: string,
  items: { title: string; description: string | null; priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT" }[],
  startBefore: number
) {
  if (items.length === 0) return startBefore;

  const rows = items.map((item, i) => ({
    id: randomUUID(),
    projectId,
    workspaceId,
    title: item.title,
    description: item.description ?? undefined,
    status: "BACKLOG" as const,
    priority: item.priority,
    reporterId,
    position: startBefore - (items.length - i) * 1000,
  }));

  await tx.insert(tasks).values(rows);
  return startBefore - items.length * 1000;
}

export async function applyTaskTemplate(params: {
  projectId: string;
  templateId: string;
  actingUserId: string;
}) {
  const project = await assertCanApply(params.projectId, params.actingUserId);
  const template = await getTaskTemplate(params.templateId);

  const createdCount = await db.transaction(async (tx) => {
    await insertTemplateItems(
      tx,
      params.projectId,
      project.workspaceId,
      params.actingUserId,
      template.items.map((i) => ({ title: i.title, description: i.description, priority: i.priority })),
      Date.now() * -1
    );

    await tx.insert(activityLogs).values({
      workspaceId: project.workspaceId,
      projectId: params.projectId,
      userId: params.actingUserId,
      action: "task_template.applied",
      metadata: { templateId: template.id, templateName: template.name, taskCount: template.items.length },
    });

    return template.items.length;
  });

  return { tasksCreated: createdCount };
}

export async function applyEngagementType(params: {
  projectId: string;
  engagementTypeId: string;
  actingUserId: string;
}) {
  const project = await assertCanApply(params.projectId, params.actingUserId);
  const engagementType = await getEngagementType(params.engagementTypeId);

  let totalCreated = 0;
  await db.transaction(async (tx) => {
    let cursor = Date.now() * -1;
    for (const link of engagementType.templates) {
      const template = await getTaskTemplate(link.template.id);
      cursor = await insertTemplateItems(
        tx,
        params.projectId,
        project.workspaceId,
        params.actingUserId,
        template.items.map((i) => ({ title: i.title, description: i.description, priority: i.priority })),
        cursor
      );
      totalCreated += template.items.length;
    }

    // Informational link only — re-applying later is always a separate,
    // explicit action, never automatic just because this row exists.
    await tx
      .insert(projectEngagementType)
      .values({ projectId: params.projectId, engagementTypeId: params.engagementTypeId })
      .onConflictDoUpdate({
        target: projectEngagementType.projectId,
        set: { engagementTypeId: params.engagementTypeId },
      });

    await tx.insert(activityLogs).values({
      workspaceId: project.workspaceId,
      projectId: params.projectId,
      userId: params.actingUserId,
      action: "engagement_type.applied",
      metadata: { engagementTypeId: engagementType.id, engagementTypeName: engagementType.name, taskCount: totalCreated },
    });
  });

  return { tasksCreated: totalCreated };
}
