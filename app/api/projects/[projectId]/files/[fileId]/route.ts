/**
 * GET    /api/projects/:projectId/files/:fileId -> download the file
 * DELETE /api/projects/:projectId/files/:fileId -> delete it
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../auth/require-user";
import { deleteProjectFile, getProjectFileForDownload } from "../../../../../../services/project-files";

export const GET = withAuth(async (_req, userId, params) => {
  const { file, contents } = await getProjectFileForDownload(params.fileId, userId);
  return new NextResponse(contents, {
    headers: {
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.fileName)}"`,
      "Content-Length": String(file.sizeBytes),
    },
  });
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await deleteProjectFile(params.fileId, userId);
  return NextResponse.json({ success: true });
});
