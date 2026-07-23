/**
 * Task list templates — superadmin builds/maintains these (name + an
 * ordered list of title/description/priority items); any project member
 * who can create tasks may later apply one to populate a backlog (see
 * services/apply-template.ts). Mirrors task_templates/task_template_items
 * RLS in db/rls-policies.sql: readable by any authenticated user, writable
 * only by a super admin.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { taskTemplates, taskTemplateItems } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

async function assertSuperAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) {
    throw new NotAuthorizedError("Only a super admin can manage task templates.");
  }
}

/** Any authenticated user can list templates — the "apply a template" picker needs this. */
export async function listTaskTemplates() {
  return db.query.taskTemplates.findMany({
    orderBy: (t, { asc }) => [asc(t.name)],
    with: { items: { orderBy: (i, { asc }) => [asc(i.position)] } },
  });
}

export async function getTaskTemplate(templateId: string) {
  const template = await db.query.taskTemplates.findFirst({
    where: eq(taskTemplates.id, templateId),
    with: { items: { orderBy: (i, { asc }) => [asc(i.position)] } },
  });
  if (!template) throw new NotFoundError("Task template not found.");
  return template;
}

export async function createTaskTemplate(params: {
  actingUserId: string;
  name: string;
  description?: string;
  items: { title: string; description?: string; priority?: Priority }[];
}) {
  await assertSuperAdmin(params.actingUserId);

  const name = params.name.trim();
  if (!name) throw new Error("Template name is required.");
  if (params.items.length === 0) throw new Error("A template needs at least one task.");

  return db.transaction(async (tx) => {
    const [template] = await tx
      .insert(taskTemplates)
      .values({ name, description: params.description, createdBy: params.actingUserId })
      .returning();

    await tx.insert(taskTemplateItems).values(
      params.items.map((item, index) => ({
        templateId: template.id,
        title: item.title.trim(),
        description: item.description,
        priority: item.priority ?? "MEDIUM",
        position: index * 1000,
      }))
    );

    return getTaskTemplate(template.id);
  });
}

export async function updateTaskTemplate(params: {
  templateId: string;
  actingUserId: string;
  name?: string;
  description?: string | null;
  /** Full replacement of the item list — simpler and safer than diffing individual rows for a builder UI. */
  items?: { title: string; description?: string; priority?: Priority }[];
}) {
  await assertSuperAdmin(params.actingUserId);

  const existing = await db.query.taskTemplates.findFirst({ where: eq(taskTemplates.id, params.templateId) });
  if (!existing) throw new NotFoundError("Task template not found.");

  await db.transaction(async (tx) => {
    if (params.name !== undefined || params.description !== undefined) {
      await tx
        .update(taskTemplates)
        .set({
          ...(params.name !== undefined ? { name: params.name.trim() } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(taskTemplates.id, params.templateId));
    }

    if (params.items) {
      if (params.items.length === 0) throw new Error("A template needs at least one task.");
      await tx.delete(taskTemplateItems).where(eq(taskTemplateItems.templateId, params.templateId));
      await tx.insert(taskTemplateItems).values(
        params.items.map((item, index) => ({
          templateId: params.templateId,
          title: item.title.trim(),
          description: item.description,
          priority: item.priority ?? "MEDIUM",
          position: index * 1000,
        }))
      );
    }
  });

  return getTaskTemplate(params.templateId);
}

export async function deleteTaskTemplate(templateId: string, actingUserId: string) {
  await assertSuperAdmin(actingUserId);
  const existing = await db.query.taskTemplates.findFirst({ where: eq(taskTemplates.id, templateId) });
  if (!existing) throw new NotFoundError("Task template not found.");
  // engagement_type_templates rows referencing this template cascade-delete
  // via the FK's onDelete: "cascade" — an engagement type just ends up with
  // one fewer linked template rather than being blocked from deletion.
  await db.delete(taskTemplates).where(eq(taskTemplates.id, templateId));
}
