/**
 * GET/PATCH/DELETE /api/admin/custom-roles/:customRoleId
 * Read is open to any authenticated user; write is superadmin-only
 * (enforced in services/custom-roles.ts, backed by RLS).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { deleteCustomRole, getCustomRoleWithGrants, updateCustomRole } from "../../../../../services/custom-roles";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  // When present, fully replaces the role's grants (see
  // services/custom-roles.ts's syncCustomRoleGrants) — the edit dialog's
  // tickbox grid always submits the complete current selection, not a diff.
  grantedKeys: z.array(z.string().min(1).max(100)).optional(),
});

export const GET = withAuth(async (_req, _userId, params) => {
  const role = await getCustomRoleWithGrants(params.customRoleId);
  return NextResponse.json(role);
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await updateCustomRole({ customRoleId: params.customRoleId, actingUserId: userId, ...parsed.data });
  const role = await getCustomRoleWithGrants(params.customRoleId);
  return NextResponse.json(role);
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await deleteCustomRole(params.customRoleId, userId);
  return NextResponse.json({ success: true });
});
