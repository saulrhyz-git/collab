/**
 * Wraps every authenticated request in a transaction that sets the RLS
 * session GUCs (see db/rls-policies.sql) before running any query, and
 * clears them on the way out. This is the single choke point that makes
 * RLS actually enforce tenant isolation — if a route handler forgets to
 * call this, every query still executes, but every policy will fail closed
 * (current_setting returns '' which matches nothing).
 */

import { sql } from "drizzle-orm";
import type { db as dbType } from "./client";

export async function withRlsContext<T>(
  db: typeof dbType,
  ctx: { userId: string; workspaceId: string | null },
  fn: (tx: typeof dbType) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`);
    await tx.execute(
      sql`SELECT set_config('app.current_workspace_id', ${ctx.workspaceId ?? ""}, true)`
    );
    return fn(tx as unknown as typeof dbType);
  });
}
