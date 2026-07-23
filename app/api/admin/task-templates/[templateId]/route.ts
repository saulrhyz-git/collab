/**
 * GET/PATCH/DELETE /api/admin/task-templates/:templateId
 * Read is open to any authenticated user; write is superadmin-only
 * (enforced in services/task-templates.ts, backed by RLS).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../../auth/require-user";
import { deleteTaskTemplate, getTaskTemplate, updateTaskTemplate } from "../../../../../services/task-templates";

const itemSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  items: z.array(itemSchema).min(1).optional(),
});

export const GET = withAuth(async (_req, _userId, params) => {
  const template = await getTaskTemplate(params.templateId);
  return NextResponse.json(template);
});

export const PATCH = withAuth(async (req, userId, params) => {
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const template = await updateTaskTemplate({ templateId: params.templateId, actingUserId: userId, ...parsed.data });
  return NextResponse.json(template);
});

export const DELETE = withAuth(async (_req, userId, params) => {
  await deleteTaskTemplate(params.templateId, userId);
  return NextResponse.json({ success: true });
});
