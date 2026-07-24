/**
 * GET  /api/clients/:clientId/members -> list client-wide collaborators
 * POST /api/clients/:clientId/members -> grant a CLIENT-scoped custom role
 *      directly to an existing app user (see services/client-invitations.ts
 *      for the by-email invite flow instead).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { addClientMember, listClientMembers } from "../../../../../services/client-members";

const addSchema = z.object({
  targetUserId: z.string().uuid(),
  customRoleId: z.string().uuid(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const members = await listClientMembers(params.clientId, userId);
  return NextResponse.json(members);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await addClientMember({ clientId: params.clientId, actingUserId: userId, ...parsed.data });
  return NextResponse.json({ success: true }, { status: 201 });
});
