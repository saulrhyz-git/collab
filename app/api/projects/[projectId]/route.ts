/**
 * GET    /api/projects/:projectId -> project detail
 * PATCH  /api/projects/:projectId -> update name/description/visibility
 * DELETE /api/projects/:projectId -> archive (soft delete)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { getProject, updateProject, archiveProject } from "../../../../services/projects";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  visibility: z.enum(["PUBLIC_TO_WORKSPACE", "PRIVATE_TO_MEMBERS"]).optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const project = await getProject(params.projectId, userId);
  return NextResponse.json(project);
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const project = await updateProject({ projectId: params.projectId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(project);
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await archiveProject(params.projectId, userId);
  return NextResponse.json({ success: true });
});
