/**
 * PATCH /api/projects/:projectId/tasks/:taskId/move
 * Body: { status, position } — called by KanbanBoard.tsx on drag-end.
 * This HTTP call is the persistence source of truth; the client also emits
 * a `task:move` socket event separately purely to notify other connected
 * collaborators (see components/KanbanBoard.tsx and realtime/socket-server.ts).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { moveTask } from "../../../../../../../services/tasks";

const moveSchema = z.object({
  status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "ARCHIVED"]),
  position: z.number(),
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = moveSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const task = await moveTask({
    projectId: params.projectId,
    taskId: params.taskId,
    actingUserId: userId,
    status: parsed.data.status,
    position: parsed.data.position,
  });
  return NextResponse.json(task);
});
