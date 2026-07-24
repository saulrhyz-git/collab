/**
 * GET  /api/clients/:clientId/invitations?status=PENDING -> list invites
 * POST /api/clients/:clientId/invitations -> invite by email to a
 *      CLIENT-scoped custom role (access across every one of the client's
 *      engagements at once).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { listClientInvitations, sendClientInvite } from "../../../../../services/client-invitations";

const sendInviteSchema = z.object({
  targetEmail: z.string().email(),
  customRoleId: z.string().uuid(),
});

const statusFilterSchema = z.enum(["PENDING", "ACCEPTED", "DECLINED", "EXPIRED", "REVOKED"]).optional();

export const GET = withAuth(async (req, userId, params) => {
  const statusParsed = statusFilterSchema.safeParse(new URL(req.url).searchParams.get("status") ?? undefined);
  if (!statusParsed.success) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }
  const invites = await listClientInvitations({ clientId: params.clientId, requestingUserId: userId, status: statusParsed.data });
  return NextResponse.json(invites);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = sendInviteSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await sendClientInvite({ clientId: params.clientId, inviterId: userId, ...parsed.data });
  return NextResponse.json(result, { status: 201 });
});
