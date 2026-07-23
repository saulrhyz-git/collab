/**
 * POST /api/projects/:projectId/tasks/:taskId/dependencies
 * Body: { predecessorTaskId, type? } — :taskId in the URL is always the successor
 * (i.e. "this task depends on predecessorTaskId").
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../../../auth/require-user";
import { addDependency, CyclicDependencyError } from "../../../../../../../services/task-dependencies";

const addSchema = z.object({
  predecessorTaskId: z.string().uuid(),
  type: z.enum(["FINISH_TO_START", "START_TO_START", "FINISH_TO_FINISH", "START_TO_FINISH"]).optional(),
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const dep = await addDependency({
      predecessorTaskId: parsed.data.predecessorTaskId,
      successorTaskId: params.taskId,
      type: parsed.data.type,
      actingUserId: userId,
    });
    return NextResponse.json(dep, { status: 201 });
  } catch (err) {
    if (err instanceof CyclicDependencyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
