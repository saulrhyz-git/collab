/**
 * GET  /api/projects/:projectId/tasks/:taskId/comments -> thread
 * POST /api/projects/:projectId/tasks/:taskId/comments -> post a comment
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { listComments, addComment } from "../../../../../../../services/task-comments";

const addSchema = z.object({ body: z.string().min(1).max(5000) });

export const GET = withAuth(async (_req, userId, params) => {
  const comments = await listComments(params.taskId, userId);
  return NextResponse.json(comments);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const comment = await addComment({ taskId: params.taskId, authorId: userId, body: parsed.data.body });
  return NextResponse.json(comment, { status: 201 });
});
