/**
 * Re-exported for naming continuity — the real implementation lives in
 * db/client.ts (it needs access to the module-private `poolDb` and the
 * AsyncLocalStorage instance, so it can't live in a separate file without
 * also exporting those internals).
 *
 * Earlier versions of this file defined a `withRlsContext` that was never
 * actually called from any route or service — every `db.*` call in the
 * app ran with no RLS session context set, which under
 * `FORCE ROW LEVEL SECURITY` means every policy's `current_app_user_id()`
 * resolved to NULL and every query would have silently returned zero rows
 * (or failed a WITH CHECK) against a real Postgres instance. The fix
 * moved the implementation into db/client.ts as `runWithRlsContext`,
 * backed by AsyncLocalStorage, and wired it into the actual request path:
 * auth/require-user.ts's `withAuth`, and auth/workspace-context.middleware.ts's
 * `resolveRequestContext` / `switchActiveWorkspace` / `withWorkspaceContext`.
 */
export { runWithRlsContext } from "./client";
