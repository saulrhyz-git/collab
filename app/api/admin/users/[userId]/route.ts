/**
 * PATCH /api/admin/users/:userId -> edit an existing user's name/contact/
 *       email/business details (not role — see .../role — and not password
 *       — see .../reset-password).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { updateUserBySuperAdmin } from "../../../../../services/users-admin";

const updateSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  contactNumber: z.string().min(1).max(40).optional(),
  email: z.string().email().optional(),
  businessName: z.string().max(200).nullable().optional(),
  businessAddress: z.string().max(2000).nullable().optional(),
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const updated = await updateUserBySuperAdmin({ targetUserId: params.userId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(updated);
});
