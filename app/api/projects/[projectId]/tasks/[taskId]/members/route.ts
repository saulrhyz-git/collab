/**
 * GET  /api/projects/:projectId/tasks/:taskId/members -> list this task's
 *      narrow VIEWER/EDITOR collaborators (true task-level ACL — separate
 *      from the engagement's own project_members roster).
 * POST /api/projects/:projectId/tasks/:taskId/members -> grant direct
 *      access to an existing app user (see task-invitations for by-email).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { addTaskMember, listTaskMembers } from "../../../../../../../services/task-members";

const addSchema = z.object({
  targetUserId: z.string().uuid(),
  role: z.enum(["VIEWER", "EDITOR"]),
});

export const GET = withAuth(async (_req, userId, params) => {
  const members = await listTaskMembers(params.taskId, userId);
  return NextResponse.json(members);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await addTaskMember({ taskId: params.taskId, actingUserId: userId, ...parsed.data });
  return NextResponse.json({ success: true }, { status: 201 });
});
