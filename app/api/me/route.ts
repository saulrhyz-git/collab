/**
 * GET   /api/me -> the signed-in user's own profile
 * PATCH /api/me -> edit own name/contact/business fields/avatar/email
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../auth/require-user";
import { getOwnProfile, updateOwnProfile } from "../../../services/profile";

const updateSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  contactNumber: z.string().max(40).nullable().optional(),
  businessName: z.string().max(200).nullable().optional(),
  businessAddress: z.string().max(2000).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export const GET = withAuth(async (_req, userId) => {
  const profile = await getOwnProfile(userId);
  return NextResponse.json(profile);
});

export const PATCH = withAuth(async (req, userId) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const profile = await updateOwnProfile({ userId, ...parsed.data });
  return NextResponse.json(profile);
});
