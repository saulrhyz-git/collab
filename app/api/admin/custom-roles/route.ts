/**
 * GET  /api/admin/custom-roles?scope=PROJECT|CLIENT -> list custom roles —
 *      any authenticated user (invite pickers and the permission matrix
 *      need this, not just superadmins; RLS backs the read side too).
 * POST /api/admin/custom-roles -> create a custom role — superadmin-only.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { createCustomRole, listCustomRoles } from "../../../../services/custom-roles";

const scopeFilterSchema = z.enum(["PROJECT", "CLIENT"]).optional();

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scope: z.enum(["PROJECT", "CLIENT"]),
  description: z.string().optional(),
  // Aspect x action keys ticked in the create dialog's inline permission
  // grid (e.g. "tasks.edit", "files.delete") — granted immediately as part
  // of role creation, not as a separate follow-up step on another page.
  grantedKeys: z.array(z.string().min(1).max(100)).optional(),
});

export const GET = withAuth(async (req) => {
  const scopeParsed = scopeFilterSchema.safeParse(new URL(req.url).searchParams.get("scope") ?? undefined);
  if (!scopeParsed.success) {
    return NextResponse.json({ error: "Invalid scope filter" }, { status: 400 });
  }
  const roles = await listCustomRoles(scopeParsed.data);
  return NextResponse.json(roles);
});

export const POST = withAuth(async (req, userId) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const role = await createCustomRole({ actingUserId: userId, ...parsed.data });
  return NextResponse.json(role, { status: 201 });
});
