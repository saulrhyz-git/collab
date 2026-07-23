/**
 * DELETE /api/projects/:projectId/tasks/:taskId/dependencies/:dependencyId
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../../../auth/require-user";
import { removeDependency } from "../../../../../../../../services/task-dependencies";

export const DELETE = withAuth(async (_req, userId, params) => {
  await removeDependency({ dependencyId: params.dependencyId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
