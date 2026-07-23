/**
 * GET  /api/admin/engagement-types -> list types with their linked templates
 *      — any authenticated user (the "new engagement" type picker needs it).
 * POST /api/admin/engagement-types -> create a type — superadmin-only.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { createEngagementType, listEngagementTypes } from "../../../../services/engagement-types";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  templateIds: z.array(z.string().uuid()).default([]),
});

export const GET = withAuth(async () => {
  const types = await listEngagementTypes();
  return NextResponse.json(types);
});

export const POST = withAuth(async (req, userId) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const type = await createEngagementType({ actingUserId: userId, ...parsed.data });
  return NextResponse.json(type, { status: 201 });
});
