/**
 * GET /api/projects/:projectId/members -> list project collaborators
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../auth/require-user";
import { listProjectMembers } from "../../../../../services/project-members";

export const GET = withAuth(async (_req, userId, params) => {
  const members = await listProjectMembers(params.projectId, userId);
  return NextResponse.json(members);
});
