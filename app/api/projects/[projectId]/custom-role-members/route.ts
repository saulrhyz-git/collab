/**
 * GET  /api/projects/:projectId/custom-role-members -> list custom-role
 *      grants layered on top of this engagement's project_members roster.
 * POST /api/projects/:projectId/custom-role-members -> grant a
 *      PROJECT-scoped custom role to an existing project member.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { grantProjectCustomRole, listProjectCustomRoleMembers } from "../../../../../services/project-custom-role-members";

const grantSchema = z.object({
  targetUserId: z.string().uuid(),
  customRoleId: z.string().uuid(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const members = await listProjectCustomRoleMembers(params.projectId, userId);
  return NextResponse.json(members);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = grantSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await grantProjectCustomRole({ projectId: params.projectId, actingUserId: userId, ...parsed.data });
  return NextResponse.json({ success: true }, { status: 201 });
});
