/**
 * POST /api/projects/:projectId/apply-template
 * Body: { templateId } | { engagementTypeId }
 *
 * Populates the project's BACKLOG from a task template, or from every
 * template linked to an engagement type (and records that link on the
 * project). Available to whoever already has task-creation rights on this
 * project — see services/apply-template.ts for the exact permission mirror
 * of project_engagement_type_write / tasks_write RLS.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { applyEngagementType, applyTaskTemplate } from "../../../../../services/apply-template";

const bodySchema = z.union([
  z.object({ templateId: z.string().uuid() }),
  z.object({ engagementTypeId: z.string().uuid() }),
]);

export const POST = withAuth(async (req, userId, params) => {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result =
    "templateId" in parsed.data
      ? await applyTaskTemplate({ projectId: params.projectId, templateId: parsed.data.templateId, actingUserId: userId })
      : await applyEngagementType({
          projectId: params.projectId,
          engagementTypeId: parsed.data.engagementTypeId,
          actingUserId: userId,
        });

  return NextResponse.json(result);
});
