/**
 * GET   /api/admin/permissions -> full permission catalog + role grants (matrix UI's data source)
 * PATCH /api/admin/permissions -> toggle a single (scope, role, permissionKey) cell
 *
 * Superadmin-only, both directions. RLS backs this up independently
 * (role_permissions_write requires is_super_admin()), but the route checks
 * first so a non-superadmin gets a clean 403 rather than a raw Postgres
 * RLS error, and so the read side (which RLS actually leaves open to any
 * authenticated user, since ordinary requests need to read grants to
 * authorize themselves) is still restricted to admins here — the matrix
 * itself is an admin-facing view, not something every user should be able
 * to fetch wholesale.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { isSuperAdmin } from "../../../../auth/super-admin";
import { getPermissionMatrix, setRolePermission, NotAuthorizedError } from "../../../../services/permissions";

const patchSchema = z.object({
  scope: z.enum(["WORKSPACE", "PROJECT"]),
  role: z.string().min(1).max(30),
  permissionKey: z.string().min(1).max(100),
  granted: z.boolean(),
});

export const GET = withAuth(async (_req, userId) => {
  if (!(await isSuperAdmin(userId))) {
    return NextResponse.json({ error: "Only a super admin can view the permissions matrix." }, { status: 403 });
  }
  const matrix = await getPermissionMatrix();
  return NextResponse.json(matrix);
});

export const PATCH = withAuth(async (req, userId) => {
  if (!(await isSuperAdmin(userId))) {
    return NextResponse.json({ error: "Only a super admin can edit the permissions matrix." }, { status: 403 });
  }
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    await setRolePermission({ ...parsed.data, actingUserId: userId });
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
  const matrix = await getPermissionMatrix();
  return NextResponse.json(matrix);
});
