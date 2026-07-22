/**
 * Lightweight auth guard for routes whose authorization is entirely
 * resource-scoped (project id / task id / invite id already in the URL)
 * rather than dependent on the caller's *active* workspace.
 *
 * Why this exists separately from withWorkspaceContext: a user's active
 * workspace (the cookie) is just "what's showing in the switcher right
 * now" — it has no bearing on whether they're allowed to touch a specific
 * project that happens to live in a *different* workspace they also
 * belong to. Gating those routes on the active-workspace cookie would
 * either wrongly 403 a valid cross-workspace action or, worse, tempt a
 * future maintainer into trusting the cookie's workspace id for
 * authorization instead of re-deriving the resource's real workspace from
 * the DB. Every service function in `services/*` re-derives ownership
 * from the resource itself and re-checks membership — this guard only
 * establishes *who* is calling, never *what* they're allowed to do.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "./index";
import { runWithRlsContext } from "../db/client";

export class UnauthenticatedError extends Error {}

export async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new UnauthenticatedError("No active session.");
  return session.user.id;
}

/** Domain errors thrown by services/* that every wrapped route should map consistently. */
export function mapDomainError(err: unknown): NextResponse | null {
  // Custom Error subclasses don't set `.name` to their class name unless the
  // constructor does so explicitly (it's inherited as "Error" otherwise) —
  // `.constructor.name` is what actually reflects the subclass.
  const name = err instanceof Error ? err.constructor.name : undefined;
  switch (name) {
    case "UnauthenticatedError":
      return NextResponse.json({ error: (err as Error).message || "Unauthenticated" }, { status: 401 });
    case "NotAuthorizedError":
      return NextResponse.json({ error: (err as Error).message || "Forbidden" }, { status: 403 });
    case "InvalidInviteError":
    case "NotFoundError":
      return NextResponse.json({ error: (err as Error).message || "Not found" }, { status: 404 });
    case "InviteAlreadyResolvedError":
    case "CannotRemoveOwnerError":
      return NextResponse.json({ error: (err as Error).message || "Conflict" }, { status: 409 });
    case "InviteExpiredError":
      return NextResponse.json({ error: (err as Error).message || "Expired" }, { status: 410 });
    case "CannotRemoveLastAdminError":
      return NextResponse.json({ error: (err as Error).message || "Conflict" }, { status: 409 });
    default:
      return null;
  }
}

/**
 * Wraps a route handler: resolves the caller's user id, establishes the
 * RLS session context for the DB connection used by everything `fn` (and
 * anything it calls, arbitrarily deep — see db/client.ts) touches, maps
 * any thrown domain error (by constructor name — see mapDomainError) to
 * the right HTTP status, and re-throws anything unrecognized as a 500.
 */
export function withAuth(
  fn: (req: NextRequest, userId: string, params: Record<string, string>) => Promise<NextResponse>
) {
  return async (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> } | { params: Record<string, string> }) => {
    try {
      const userId = await requireUserId();
      const params = await (routeCtx as any).params;
      return await runWithRlsContext({ userId }, () => fn(req, userId, params));
    } catch (err) {
      const mapped = mapDomainError(err);
      if (mapped) return mapped;
      console.error(err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
