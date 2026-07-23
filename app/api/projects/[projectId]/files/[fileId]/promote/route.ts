/**
 * POST /api/projects/:projectId/files/:fileId/promote
 * The AI Review tab's "Add to References" button — flips a file's category
 * from AI_REVIEWED to REFERENCE so it also shows up in the References tab.
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../../auth/require-user";
import { promoteFileToReferences } from "../../../../../../../services/project-files";

export const POST = withAuth(async (_req, userId, params) => {
  const file = await promoteFileToReferences(params.fileId, userId);
  return NextResponse.json(file);
});
