/**
 * DELETE /api/projects/:projectId/tasks/:taskId/invitations/:inviteId -> revoke
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../../../auth/require-user";
import { revokeTaskInvite } from "../../../../../../../../services/task-invitations";

export const DELETE = withAuth(async (_req, userId, params) => {
  await revokeTaskInvite({ inviteId: params.inviteId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
