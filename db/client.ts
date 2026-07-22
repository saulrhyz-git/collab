import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema";

// The pool connects as an application role that owns no BYPASSRLS privilege.
// RLS policies use FORCE ROW LEVEL SECURITY, so even the table owner role
// (if misconfigured) would still be subject to policies — defense in depth.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

type Schema = typeof schema;
type Db = NodePgDatabase<Schema>;

// Plain pool-backed instance, used only as a fallback for the handful of
// callers that intentionally run before any authenticated context exists
// (looking a user up by email during login/signup) or against tables that
// aren't RLS-protected (`users`). Every other read/write should happen
// inside runWithRlsContext.
const poolDb: Db = drizzle(pool, { schema });

const requestDb = new AsyncLocalStorage<Db>();

/**
 * The `db` every service/route imports. Proxies every property access to
 * whichever drizzle instance is active for the current async context: the
 * RLS-scoped transaction set up by runWithRlsContext if one is running,
 * otherwise the plain pool instance. Service code never needs to know
 * which one it's getting — `import { db } from "../db/client"` behaves
 * identically whether or not the call happens to be RLS-scoped, so this
 * is the one place that has to be correct rather than something every
 * service function has to remember to opt into.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, _receiver) {
    const active = requestDb.getStore() ?? poolDb;
    const value = Reflect.get(active as object, prop);
    return typeof value === "function" ? value.bind(active) : value;
  },
});

/**
 * Establishes the RLS session context (see db/rls-policies.sql) for the
 * duration of `fn`. Every `db.*` call made anywhere during `fn` — however
 * deep the call stack, including inside service functions that have no
 * idea RLS exists — transparently runs against a Postgres session that
 * has `app.current_user_id` set, via the AsyncLocalStorage above.
 *
 * Implemented as a drizzle transaction (not a raw `BEGIN`/`SET LOCAL` on a
 * bare pool client) specifically so that services which themselves call
 * `db.transaction(...)` for atomicity keep working: drizzle-orm turns a
 * transaction opened inside an already-open transaction into a SAVEPOINT
 * automatically, so nesting is safe and a rollback of the inner one
 * doesn't take down the RLS context with it.
 *
 * Call this exactly once per request, as high up as possible (the auth
 * guards in auth/require-user.ts and auth/workspace-context.middleware.ts
 * already do this) — nothing beneath it needs to call it again.
 */
export async function runWithRlsContext<T>(
  ctx: { userId: string; workspaceId?: string | null },
  fn: () => Promise<T>
): Promise<T> {
  return poolDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${ctx.workspaceId ?? ""}, true)`);
    return requestDb.run(tx as unknown as Db, fn);
  });
}
