/**
 * GET  /api/projects/:projectId/invitations?status=PENDING  -> list invites
 * POST /api/projects/:projectId/invitations                 -> send invite
 *
 * Revoke lives at /api/projects/:projectId/invitations/:inviteId (DELETE) —
 * see [inviteId]/route.ts.
 *
 * Authorization is entirely resource-scoped (derived from the project's own
 * workspace_id inside the service layer), so these routes use the plain
 * `withAuth` guard rather than `withWorkspaceContext` — see
 * auth/require-user.ts for why that distinction matters.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { sendProjectInvite, listProjectInvitations } from "../../../../../services/invitations";

const sendInviteSchema = z.object({
  targetEmail: z.string().email(),
  role: z.enum(["PROJECT_ADMIN", "EDITOR", "VIEWER"]),
});

const statusFilterSchema = z
  .enum(["PENDING", "ACCEPTED", "DECLINED", "EXPIRED", "REVOKED"])
  .optional();

export const GET = withAuth(async (req, userId, params) => {
  const statusParsed = statusFilterSchema.safeParse(
    new URL(req.url).searchParams.get("status") ?? undefined
  );
  if (!statusParsed.success) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }

  const invites = await listProjectInvitations({
    projectId: params.projectId,
    requestingUserId: userId,
    status: statusParsed.data,
  });
  return NextResponse.json(invites);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = sendInviteSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await sendProjectInvite({
    projectId: params.projectId,
    inviterId: userId,
    targetEmail: parsed.data.targetEmail,
    role: parsed.data.role,
  });
  return NextResponse.json(result, { status: 201 });
});
