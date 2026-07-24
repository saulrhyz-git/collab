/**
 * PATCH  /api/projects/:projectId/tasks/:taskId/checklist/:itemId -> toggle/edit an item
 * DELETE /api/projects/:projectId/tasks/:taskId/checklist/:itemId
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../../auth/require-user";
import { updateChecklistItem, deleteChecklistItem } from "../../../../../../../../services/task-checklist";

const updateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  remarks: z.string().max(2000).nullable().optional(),
  completed: z.boolean().optional(),
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const item = await updateChecklistItem({ itemId: params.itemId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(item);
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await deleteChecklistItem({ itemId: params.itemId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
