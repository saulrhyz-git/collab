/**
 * GET  /api/workspaces/:workspaceId/clients -> list non-archived clients in the workspace
 * POST /api/workspaces/:workspaceId/clients -> add a client
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { createClient, listClientsForWorkspace } from "../../../../../services/clients";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  primaryContactName: z.string().max(200).optional(),
  primaryContactEmail: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const list = await listClientsForWorkspace(params.workspaceId, userId);
  return NextResponse.json(list);
});

export const POST = withAuth(async (req, userId, params) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const client = await createClient({
    workspaceId: params.workspaceId,
    createdBy: userId,
    ...parsed.data,
  });
  return NextResponse.json(client, { status: 201 });
});
