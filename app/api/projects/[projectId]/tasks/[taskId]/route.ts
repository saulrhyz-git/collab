/**
 * GET   /api/projects/:projectId/tasks/:taskId -> full detail (TaskDetailPanel.tsx)
 * PATCH /api/projects/:projectId/tasks/:taskId -> edit title/description/priority/status/assignee/dates
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../auth/require-user";
import { getTaskDetail, updateTask } from "../../../../../../services/tasks";

const updateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "ARCHIVED"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const task = await getTaskDetail(params.taskId, userId);
  return NextResponse.json(task);
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const task = await updateTask({ taskId: params.taskId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(task);
});
