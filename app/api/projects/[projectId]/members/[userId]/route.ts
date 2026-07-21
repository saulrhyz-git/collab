/**
 * PATCH  /api/projects/:projectId/members/:userId -> change a member's role
 * DELETE /api/projects/:projectId/members/:userId -> remove a member (or leave, if self)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../auth/require-user";
import { updateProjectMemberRole, removeProjectMember } from "../../../../../../services/project-members";

const patchSchema = z.object({
  role: z.enum(["PROJECT_ADMIN", "EDITOR", "VIEWER"]),
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  await updateProjectMemberRole({
    projectId: params.projectId,
    targetUserId: params.userId,
    newRole: parsed.data.role,
    actingUserId: userId,
  });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await removeProjectMember({
    projectId: params.projectId,
    targetUserId: params.userId,
    actingUserId: userId,
  });
  return NextResponse.json({ success: true });
});
