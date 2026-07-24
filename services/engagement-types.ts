/**
 * Engagement types — the "kind of matter" (e.g. "M&A Due Diligence",
 * "Employment Contract Review") that maps to one or more task list
 * templates. Superadmin-only to build/maintain, same as task templates;
 * readable by anyone (the "new engagement" dialog's type picker needs it).
 * Mirrors engagement_types/engagement_type_templates RLS.
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { engagementTypes, engagementTypeTemplates, taskTemplates } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

async function assertSuperAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) {
    throw new NotAuthorizedError("Only a super admin can manage engagement types.");
  }
}

export async function listEngagementTypes() {
  return db.query.engagementTypes.findMany({
    orderBy: (e, { asc }) => [asc(e.name)],
    with: { templates: { with: { template: true } } },
  });
}

export async function getEngagementType(engagementTypeId: string) {
  const type = await db.query.engagementTypes.findFirst({
    where: eq(engagementTypes.id, engagementTypeId),
    with: { templates: { with: { template: true } } },
  });
  if (!type) throw new NotFoundError("Engagement type not found.");
  return type;
}

export async function createEngagementType(params: {
  actingUserId: string;
  name: string;
  description?: string;
  templateIds: string[];
}) {
  await assertSuperAdmin(params.actingUserId);

  const name = params.name.trim();
  if (!name) throw new Error("Engagement type name is required.");

  if (params.templateIds.length > 0) {
    const found = await db.query.taskTemplates.findMany({
      where: inArray(taskTemplates.id, params.templateIds),
      columns: { id: true },
    });
    if (found.length !== new Set(params.templateIds).size) {
      throw new NotFoundError("One or more selected task templates don't exist.");
    }
  }

  return db.transaction(async (tx) => {
    const [type] = await tx
      .insert(engagementTypes)
      .values({ name, description: params.description, createdBy: params.actingUserId })
      .returning();

    if (params.templateIds.length > 0) {
      await tx.insert(engagementTypeTemplates).values(
        params.templateIds.map((templateId) => ({ engagementTypeId: type.id, templateId }))
      );
    }

    // Re-fetch through the same transaction handle (tx), not a module-level
    // helper that resolves `db` independently — see services/projects.ts's
    // createProject for why this matters (RETURNING-vs-RLS bootstrap class
    // of bug from earlier this session).
    const withTemplates = await tx.query.engagementTypes.findFirst({
      where: eq(engagementTypes.id, type.id),
      with: { templates: { with: { template: true } } },
    });
    return withTemplates!;
  });
}

export async function updateEngagementType(params: {
  engagementTypeId: string;
  actingUserId: string;
  name?: string;
  description?: string | null;
  /** Full replacement of the linked-templates set. */
  templateIds?: string[];
}) {
  await assertSuperAdmin(params.actingUserId);

  const existing = await db.query.engagementTypes.findFirst({ where: eq(engagementTypes.id, params.engagementTypeId) });
  if (!existing) throw new NotFoundError("Engagement type not found.");

  if (params.templateIds && params.templateIds.length > 0) {
    const found = await db.query.taskTemplates.findMany({
      where: inArray(taskTemplates.id, params.templateIds),
      columns: { id: true },
    });
    if (found.length !== new Set(params.templateIds).size) {
      throw new NotFoundError("One or more selected task templates don't exist.");
    }
  }

  await db.transaction(async (tx) => {
    if (params.name !== undefined || params.description !== undefined) {
      await tx
        .update(engagementTypes)
        .set({
          ...(params.name !== undefined ? { name: params.name.trim() } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
        })
        .where(eq(engagementTypes.id, params.engagementTypeId));
    }

    if (params.templateIds) {
      await tx
        .delete(engagementTypeTemplates)
        .where(eq(engagementTypeTemplates.engagementTypeId, params.engagementTypeId));
      if (params.templateIds.length > 0) {
        await tx.insert(engagementTypeTemplates).values(
          params.templateIds.map((templateId) => ({
            engagementTypeId: params.engagementTypeId,
            templateId,
          }))
        );
      }
    }
  });

  return getEngagementType(params.engagementTypeId);
}

export async function deleteEngagementType(engagementTypeId: string, actingUserId: string) {
  await assertSuperAdmin(actingUserId);
  const existing = await db.query.engagementTypes.findFirst({ where: eq(engagementTypes.id, engagementTypeId) });
  if (!existing) throw new NotFoundError("Engagement type not found.");
  await db.delete(engagementTypes).where(eq(engagementTypes.id, engagementTypeId));
}
