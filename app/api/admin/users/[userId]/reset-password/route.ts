/**
 * POST /api/admin/users/:userId/reset-password -> set a new superadmin-typed
 *      temporary password on an existing account (flags mustResetPassword).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../auth/require-user";
import { resetUserPasswordBySuperAdmin } from "../../../../../../services/users-admin";

const resetSchema = z.object({ temporaryPassword: z.string().min(8).max(200) });

export const POST = withAuth(async (req, userId, params) => {
  const parsed = resetSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await resetUserPasswordBySuperAdmin({
    targetUserId: params.userId,
    actingUserId: userId,
    temporaryPassword: parsed.data.temporaryPassword,
  });
  return NextResponse.json({ success: true });
});
