/**
 * GET/PATCH /api/admin/smtp-settings — superadmin-only (enforced inside the
 * service, backed by RLS's smtp_settings_write). GET never returns the
 * decrypted password, only whether one is currently set.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { getSmtpSettingsForAdmin, updateSmtpSettings, NotAuthorizedError } from "../../../../services/smtp-settings";

const updateSchema = z.object({
  host: z.string().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(255).nullable().optional(),
  password: z.string().max(1000).optional(),
  fromAddress: z.union([z.string().email(), z.literal("")]).nullable().optional(),
  fromName: z.string().max(200).nullable().optional(),
  secure: z.boolean().optional(),
});

export const GET = withAuth(async (_req, userId) => {
  try {
    const settings = await getSmtpSettingsForAdmin(userId);
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
    const settings = await updateSmtpSettings({ actingUserId: userId, ...parsed.data });
    return NextResponse.json(settings);
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
});
