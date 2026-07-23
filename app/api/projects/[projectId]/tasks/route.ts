/**
 * GET  /api/projects/:projectId/tasks -> board data for KanbanBoard.tsx
 * POST /api/projects/:projectId/tasks -> create a task
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { listProjectTasks, createTask } from "../../../../../services/tasks";

const createTaskSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const tasks = await listProjectTasks(params.projectId, userId);
  return NextResponse.json(tasks);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = createTaskSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const task = await createTask({
    projectId: params.projectId,
    reporterId: userId,
    ...parsed.data,
  });
  return NextResponse.json(task, { status: 201 });
});
