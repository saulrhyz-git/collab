/**
 * GET  /api/admin/task-templates -> list templates (with items) — any
 *      authenticated user (the apply-template picker needs this, not just
 *      superadmins; RLS backs the read side independently).
 * POST /api/admin/task-templates -> create a template — superadmin-only,
 *      enforced inside the service (and by RLS's task_templates_write).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "../../../../auth/require-user";
import { createTaskTemplate, listTaskTemplates } from "../../../../services/task-templates";

const itemSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  items: z.array(itemSchema).min(1),
});

export const GET = withAuth(async () => {
  const templates = await listTaskTemplates();
  return NextResponse.json(templates);
});

export const POST = withAuth(async (req, userId) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const template = await createTaskTemplate({ actingUserId: userId, ...parsed.data });
  return NextResponse.json(template, { status: 201 });
});
