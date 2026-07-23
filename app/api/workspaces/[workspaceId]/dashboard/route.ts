/**
 * GET /api/workspaces/:workspaceId/dashboard -> everything the landing page needs in one call:
 * stats, my assigned tasks, upcoming deadlines workspace-wide, recent activity, and
 * projects/engagements grouped by client.
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../auth/require-user";
import { getWorkspaceDashboard } from "../../../../../services/dashboard";

export const GET = withAuth(async (_req, userId, params) => {
  const dashboard = await getWorkspaceDashboard(params.workspaceId, userId);
  return NextResponse.json(dashboard);
});
