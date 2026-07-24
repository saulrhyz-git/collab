/**
 * GET /api/admin/permission-catalog -> PROJECT-scope permission catalog
 * grouped by aspect (tasks/comments/files/members/engagement/ai_review),
 * each with its available view/create/edit/delete actions. This is the
 * shape the custom-role create/edit dialog's inline tickbox grid renders —
 * distinct from /api/admin/permissions, which returns the full flat
 * catalog with every role's current grant (for the standalone matrix page).
 *
 * Superadmin-only: only the custom-role manager (superadmin surface) needs
 * this shape.
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../auth/require-user";
import { isSuperAdmin } from "../../../../auth/super-admin";
import { getProjectPermissionCatalogByAspect } from "../../../../services/permissions";

export const GET = withAuth(async (_req, userId) => {
  if (!(await isSuperAdmin(userId))) {
    return NextResponse.json({ error: "Only a super admin can view the permission catalog." }, { status: 403 });
  }
  const catalog = await getProjectPermissionCatalogByAspect();
  return NextResponse.json(catalog);
});
