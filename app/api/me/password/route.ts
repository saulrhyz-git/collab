/**
 * PATCH /api/me/password -> change your own password (requires current password).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { changeOwnPassword } from "../../../../services/profile";

const changeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export const PATCH = withAuth(async (req, userId) => {
  const parsed = changeSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await changeOwnPassword({ userId, ...parsed.data });
  return NextResponse.json({ success: true });
});
