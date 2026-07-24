/**
 * DELETE /api/projects/:projectId/tasks/:taskId/members/:userId -> revoke a
 * task-level collaborator grant.
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../../../auth/require-user";
import { removeTaskMember } from "../../../../../../../../services/task-members";

export const DELETE = withAuth(async (_req, userId, params) => {
  await removeTaskMember({ taskId: params.taskId, targetUserId: params.userId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
