/**
 * GET  /api/workspaces/:workspaceId/projects -> list projects visible to the caller
 * POST /api/workspaces/:workspaceId/projects -> create a project
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { createProject, listProjectsForWorkspace } from "../../../../../services/projects";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  visibility: z.enum(["PUBLIC_TO_WORKSPACE", "PRIVATE_TO_MEMBERS"]).optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const list = await listProjectsForWorkspace(params.workspaceId, userId);
  return NextResponse.json(list);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const project = await createProject({
    workspaceId: params.workspaceId,
    createdBy: userId,
    ...parsed.data,
  });
  return NextResponse.json(project, { status: 201 });
});
