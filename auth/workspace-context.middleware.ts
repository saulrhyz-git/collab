/**
 * Active-workspace context resolution.
 *
 * The client persists the chosen workspace as a cookie (`active_workspace_id`,
 * httpOnly, sameSite=lax) that survives reloads, and also mirrors it into an
 * `X-Workspace-Id` request header for cases where cookies aren't convenient
 * (e.g. server actions calling internal APIs). Cookie is authoritative if
 * both are present and disagree — the header is a convenience, not a trust
 * boundary override.
 *
 * This middleware NEVER trusts the client's claimed workspace id without
 * verifying membership on every request — that verification is what
 * prevents a user from setting an arbitrary cookie value to view a
 * workspace they don't belong to (see Step 5 IDOR notes).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "./index";
import { db, runWithRlsContext } from "../db/client";
import { isSuperAdmin } from "./super-admin";

export const ACTIVE_WORKSPACE_COOKIE = "active_workspace_id";

export interface RequestContext {
  userId: string;
  activeWorkspaceId: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
}

export class UnauthenticatedError extends Error {}
export class NoWorkspaceAccessError extends Error {}

/**
 * Resolves and verifies the request's (user, active workspace) pair.
 * Call this at the top of every API route / server action that touches
 * workspace-scoped data. Throws on failure — callers translate to 401/403.
 */
export async function resolveRequestContext(req: NextRequest): Promise<RequestContext> {
  const session = await auth();
  if (!session?.user?.id) throw new UnauthenticatedError("No active session.");

  const userId = session.user.id;
  const claimedWorkspaceId =
    req.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? req.headers.get("x-workspace-id");

  // Self-contained RLS context: this function does its own DB reads, so it
  // establishes the session context itself rather than assuming a caller
  // already did — see db/client.ts. Without this, `workspace_members` (which
  // has FORCE ROW LEVEL SECURITY) would return zero rows for everyone,
  // including legitimate members, because Postgres wouldn't know who's asking.
  return runWithRlsContext({ userId }, async () => {
    if (!claimedWorkspaceId) {
      // No workspace selected yet — fall back to the user's personal workspace.
      const personal = await db.query.workspaces.findFirst({
        where: (w, { eq, and }) => and(eq(w.ownerId, userId), eq(w.type, "PERSONAL")),
      });
      if (!personal) throw new NoWorkspaceAccessError("No personal workspace found.");
      return { userId, activeWorkspaceId: personal.id, role: "OWNER" as const };
    }

    // Authoritative check: does this user actually have a membership row for
    // the claimed workspace? A forged cookie with someone else's workspace id
    // fails here regardless of anything the client asserts.
    const membership = await db.query.workspaceMembers.findFirst({
      where: (wm, { eq, and }) =>
        and(eq(wm.workspaceId, claimedWorkspaceId), eq(wm.userId, userId)),
    });

    if (!membership) {
      // A super admin can select any workspace as "active" without a
      // membership row — RLS independently allows this via its own
      // is_super_admin() check (db/rls-policies.sql), this is just the
      // app-layer mirror of that so the UI/role reported here is accurate.
      if (await isSuperAdmin(userId)) {
        return { userId, activeWorkspaceId: claimedWorkspaceId, role: "ADMIN" as const };
      }
      throw new NoWorkspaceAccessError(
        `User ${userId} is not a member of workspace ${claimedWorkspaceId}.`
      );
    }

    return { userId, activeWorkspaceId: claimedWorkspaceId, role: membership.role };
  });
}

/**
 * Convenience wrapper for route handlers: resolves context, re-establishes
 * the RLS session for the actual handler body (resolveRequestContext's own
 * internal runWithRlsContext call only covers its own reads — `fn` itself
 * will make further `db.*` calls via services that need context too), maps
 * known errors to HTTP responses, and otherwise hands the context to `fn`.
 */
export function withWorkspaceContext(
  fn: (req: NextRequest, ctx: RequestContext) => Promise<NextResponse>
) {
  return async (req: NextRequest) => {
    try {
      const ctx = await resolveRequestContext(req);
      return await runWithRlsContext(
        { userId: ctx.userId, workspaceId: ctx.activeWorkspaceId },
        () => fn(req, ctx)
      );
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
      }
      if (err instanceof NoWorkspaceAccessError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      throw err;
    }
  };
}

/**
 * Called when a user explicitly switches workspaces in the UI. Verifies
 * membership BEFORE setting the cookie so we never persist an unauthorized
 * workspace id, then returns the response with the cookie attached.
 */
export async function switchActiveWorkspace(
  userId: string,
  targetWorkspaceId: string
): Promise<NextResponse> {
  const { membership, superAdmin } = await runWithRlsContext({ userId }, async () => {
    const membership = await db.query.workspaceMembers.findFirst({
      where: (wm, { eq, and }) =>
        and(eq(wm.workspaceId, targetWorkspaceId), eq(wm.userId, userId)),
    });
    return { membership, superAdmin: membership ? false : await isSuperAdmin(userId) };
  });

  if (!membership && !superAdmin) {
    return NextResponse.json({ error: "Not a member of that workspace" }, { status: 403 });
  }

  const role = membership?.role ?? "ADMIN";
  const res = NextResponse.json({ activeWorkspaceId: targetWorkspaceId, role });
  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, targetWorkspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
