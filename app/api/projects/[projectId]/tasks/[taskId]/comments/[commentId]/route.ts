/**
 * DELETE /api/projects/:projectId/tasks/:taskId/comments/:commentId
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../../../auth/require-user";
import { deleteComment } from "../../../../../../../../services/task-comments";

export const DELETE = withAuth(async (_req, userId, params) => {
  await deleteComment({ commentId: params.commentId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
