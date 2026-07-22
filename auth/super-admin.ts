/**
 * Platform-wide super admin check. This is a genuine bypass — a super
 * admin can read and write every workspace and project regardless of
 * membership — so it's deliberately a single, auditable choke point
 * rather than something scattered across services as ad-hoc `if`s.
 *
 * The bypass is enforced at all three layers, matching the rest of the
 * app's defense-in-depth model (see README's IDOR section):
 *   1. Service-layer authorization checks call this helper directly.
 *   2. auth/workspace-context.middleware.ts uses it to let a super admin
 *      select any workspace as "active" without a membership row.
 *   3. Row-Level Security has its own independent `is_super_admin()` SQL
 *      function (db/rls-policies.sql) baked into is_workspace_member(),
 *      is_workspace_admin(), and is_project_member() — so even a route
 *      that forgets to check this TypeScript helper still can't be used
 *      to smuggle a non-super-admin past the database.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { isSuperAdmin: true },
  });
  return user?.isSuperAdmin ?? false;
}
