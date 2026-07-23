/**
 * GET    /api/clients/:clientId -> client detail + its engagements (projects)
 * PATCH  /api/clients/:clientId -> update name/contact/notes
 * DELETE /api/clients/:clientId -> archive (soft delete)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { getClient, updateClient, archiveClient } from "../../../../services/clients";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  primaryContactName: z.string().max(200).nullable().optional(),
  primaryContactEmail: z.string().email().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const GET = withAuth(async (_req, userId, params) => {
  const client = await getClient(params.clientId, userId);
  return NextResponse.json(client);
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const client = await updateClient({ clientId: params.clientId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(client);
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await archiveClient(params.clientId, userId);
  return NextResponse.json({ success: true });
});
