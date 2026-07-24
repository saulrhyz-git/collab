/**
 * GET  /api/projects/:projectId/tasks/:taskId/checklist -> punch-list items
 * POST /api/projects/:projectId/tasks/:taskId/checklist -> add an item
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { listChecklistItems, addChecklistItem } from "../../../../../../../services/task-checklist";

const addSchema = z.object({
  title: z.string().min(1).max(300),
  remarks: z.string().max(2000).nullable().optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const items = await listChecklistItems(params.taskId, userId);
  return NextResponse.json(items);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const item = await addChecklistItem({ taskId: params.taskId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(item, { status: 201 });
});
