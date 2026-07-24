/**
 * DELETE /api/projects/:projectId/custom-role-members/:userId?customRoleId=...
 * Revokes one custom-role grant (a user can hold more than one, so
 * customRoleId disambiguates which to remove).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../auth/require-user";
import { revokeProjectCustomRole } from "../../../../../../services/project-custom-role-members";

const querySchema = z.object({ customRoleId: z.string().uuid() });

export const DELETE = withAuth(async (req, userId, params) => {
  const parsed = querySchema.safeParse({ customRoleId: new URL(req.url).searchParams.get("customRoleId") });
  if (!parsed.success) {
    return NextResponse.json({ error: "customRoleId query parameter is required" }, { status: 400 });
  }
  await revokeProjectCustomRole({
    projectId: params.projectId,
    targetUserId: params.userId,
    customRoleId: parsed.data.customRoleId,
    actingUserId: userId,
  });
  return NextResponse.json({ success: true });
});
