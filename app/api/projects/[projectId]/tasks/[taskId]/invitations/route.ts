/**
 * GET  /api/projects/:projectId/tasks/:taskId/invitations?status=PENDING
 * POST /api/projects/:projectId/tasks/:taskId/invitations -> invite by email
 *      to VIEWER/EDITOR access on exactly this task.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { listTaskInvitations, sendTaskInvite } from "../../../../../../../services/task-invitations";

const sendInviteSchema = z.object({
  targetEmail: z.string().email(),
  role: z.enum(["VIEWER", "EDITOR"]),
});

const statusFilterSchema = z.enum(["PENDING", "ACCEPTED", "DECLINED", "EXPIRED", "REVOKED"]).optional();

export const GET = withAuth(async (req, userId, params) => {
  const statusParsed = statusFilterSchema.safeParse(new URL(req.url).searchParams.get("status") ?? undefined);
  if (!statusParsed.success) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }
  const invites = await listTaskInvitations({ taskId: params.taskId, requestingUserId: userId, status: statusParsed.data });
  return NextResponse.json(invites);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = sendInviteSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await sendTaskInvite({ taskId: params.taskId, inviterId: userId, ...parsed.data });
  return NextResponse.json(result, { status: 201 });
});
