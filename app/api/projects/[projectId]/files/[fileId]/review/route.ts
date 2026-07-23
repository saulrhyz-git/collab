/**
 * POST /api/projects/:projectId/files/:fileId/review
 * Body (optional): { provider: "openai" | "gemini" } to override the
 * platform's configured default for this one review.
 *
 * Runs the AI review synchronously and returns the structured result —
 * see services/ai-review.ts for the provider calls, permission gate, and
 * how the result gets persisted onto the file's row.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { reviewProjectFile } from "../../../../../../../services/ai-review";

const bodySchema = z.object({
  provider: z.enum(["openai", "gemini"]).optional(),
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await reviewProjectFile({
    fileId: params.fileId,
    actingUserId: userId,
    provider: parsed.data.provider,
  });
  return NextResponse.json(result);
});
