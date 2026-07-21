/**
 * GET  /api/workspaces -> workspaces for the WorkspaceSelector switcher
 * POST /api/workspaces -> create a new SHARED workspace
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId, mapDomainError } from "../../../auth/require-user";
import { listWorkspacesForUser, createSharedWorkspace } from "../../../services/workspaces";

const createSchema = z.object({ name: z.string().min(1).max(200) });

export async function GET() {
  try {
    const userId = await requireUserId();
    const workspaces = await listWorkspacesForUser(userId);
    return NextResponse.json(workspaces);
  } catch (err) {
    return mapDomainError(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const workspace = await createSharedWorkspace({ ownerId: userId, name: parsed.data.name });
    return NextResponse.json(workspace, { status: 201 });
  } catch (err) {
    return mapDomainError(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
