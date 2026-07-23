/**
 * GET/PATCH /api/admin/ai-provider-settings — superadmin-only. GET never
 * returns decrypted keys, only whether one is set per provider.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import {
  getAiProviderSettingsForAdmin,
  updateAiProviderSettings,
  NotAuthorizedError,
} from "../../../../services/ai-provider-settings";

const updateSchema = z.object({
  openaiModel: z.string().min(1).max(100).optional(),
  openaiKey: z.string().max(2000).optional(),
  geminiModel: z.string().min(1).max(100).optional(),
  geminiKey: z.string().max(2000).optional(),
  defaultProvider: z.enum(["openai", "gemini"]).optional(),
});

export const GET = withAuth(async (_req, userId) => {
  try {
    const settings = await getAiProviderSettingsForAdmin(userId);
    return NextResponse.json(settings);
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
});

export const PATCH = withAuth(async (req, userId) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const settings = await updateAiProviderSettings({ actingUserId: userId, ...parsed.data });
    return NextResponse.json(settings);
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
});
