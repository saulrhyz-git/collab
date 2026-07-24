/**
 * PATCH /api/admin/users/:userId/role -> promote/demote super admin access.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../auth/require-user";
import { setUserSuperAdminRole } from "../../../../../../services/users-admin";

const updateSchema = z.object({ isSuperAdmin: z.boolean() });

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await setUserSuperAdminRole({ targetUserId: params.userId, isSuperAdmin: parsed.data.isSuperAdmin, actingUserId: userId });
  return NextResponse.json({ success: true });
});
