/**
 * GET  /api/admin/users -> full user roster — superadmin-only.
 * POST /api/admin/users -> create a user with a superadmin-set temporary
 *      password — see services/users-admin.ts for why the password is
 *      supplied here rather than generated/emailed.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { createUserBySuperAdmin, listAllUsers } from "../../../../services/users-admin";

const createSchema = z.object({
  fullName: z.string().min(1).max(200),
  contactNumber: z.string().min(1).max(40),
  email: z.string().email(),
  role: z.enum(["USER", "SUPER_ADMIN"]),
  temporaryPassword: z.string().min(8).max(200),
  businessName: z.string().max(200).optional(),
  businessAddress: z.string().max(2000).optional(),
});

export const GET = withAuth(async (_req, userId) => {
  const rows = await listAllUsers(userId);
  return NextResponse.json(rows);
});

export const POST = withAuth(async (req, userId) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await createUserBySuperAdmin({ actingUserId: userId, ...parsed.data });
  return NextResponse.json(result, { status: 201 });
});
