/**
 * GET/PATCH/DELETE /api/admin/engagement-types/:engagementTypeId
 * Read is open to any authenticated user; write is superadmin-only.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import {
  deleteEngagementType,
  getEngagementType,
  updateEngagementType,
} from "../../../../../services/engagement-types";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  templateIds: z.array(z.string().uuid()).optional(),
});

export const GET = withAuth(async (_req, _userId, params) => {
  const type = await getEngagementType(params.engagementTypeId);
  return NextResponse.json(type);
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const type = await updateEngagementType({
    engagementTypeId: params.engagementTypeId,
    actingUserId: userId,
    ...parsed.data,
  });
  return NextResponse.json(type);
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await deleteEngagementType(params.engagementTypeId, userId);
  return NextResponse.json({ success: true });
});
