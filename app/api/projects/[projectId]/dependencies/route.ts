/**
 * GET /api/projects/:projectId/dependencies -> every dependency edge in the
 * project, for GanttChart.tsx to draw link lines against the task list it
 * already fetched from /tasks.
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../auth/require-user";
import { listProjectDependencies } from "../../../../../services/tasks";

export const GET = withAuth(async (_req, userId, params) => {
  const deps = await listProjectDependencies(params.projectId, userId);
  return NextResponse.json(deps);
});
