/**
 * GET  /api/projects/:projectId/files?category=REFERENCE|AI_REVIEWED -> list files
 * POST /api/projects/:projectId/files -> upload a file (multipart/form-data:
 *      "file" is the binary, optional "category" defaults to REFERENCE)
 */

import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "../../../../../auth/require-user";
import { listProjectFiles, uploadProjectFile } from "../../../../../services/project-files";

export const GET = withAuth(async (req: NextRequest, userId, params) => {
  const category = req.nextUrl.searchParams.get("category");
  const files = await listProjectFiles({
    projectId: params.projectId,
    userId,
    category: category === "REFERENCE" || category === "AI_REVIEWED" ? category : undefined,
  });
  return NextResponse.json(files);
});

export const POST = withAuth(async (req: NextRequest, userId, params) => {
  const form = await req.formData();
  const uploaded = form.get("file");
  if (!(uploaded instanceof File)) {
    return NextResponse.json({ error: "A file is required." }, { status: 400 });
  }
  const categoryField = form.get("category");
  const category = categoryField === "AI_REVIEWED" ? "AI_REVIEWED" : "REFERENCE";

  const contents = Buffer.from(await uploaded.arrayBuffer());
  const file = await uploadProjectFile({
    projectId: params.projectId,
    actingUserId: userId,
    fileName: uploaded.name,
    mimeType: uploaded.type || "application/octet-stream",
    contents,
    category,
  });
  return NextResponse.json(file, { status: 201 });
});
