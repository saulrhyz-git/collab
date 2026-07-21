/**
 * POST /api/workspaces/active
 * Body: { workspaceId }
 * Switches the caller's active workspace — verifies membership before
 * setting the cookie (see auth/workspace-context.middleware.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "../../../../auth";
import { switchActiveWorkspace } from "../../../../auth/workspace-context.middleware";

const schema = z.object({ workspaceId: z.string().uuid() });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  return switchActiveWorkspace(session.user.id, parsed.data.workspaceId);
}
