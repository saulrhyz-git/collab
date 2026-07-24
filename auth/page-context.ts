/**
 * Shared server-component helper for every top-level page.tsx that needs to
 * render AppSidebar (dashboard, clients, engagements, client detail, project
 * detail, profile): resolves who's signed in, whether they're a super
 * admin, and which workspace is active — the same three things app/page.tsx
 * originally resolved inline before there was more than one page that
 * needed them.
 *
 * Redirects to /login itself (rather than returning null) since every
 * caller would otherwise have to duplicate that check.
 */

import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { NextRequest } from "next/server";
import { auth } from "./index";
import { isSuperAdmin } from "./super-admin";
import { resolveRequestContext } from "./workspace-context.middleware";

export interface PageContext {
  userId: string;
  userName: string;
  userEmail: string;
  isSuperAdmin: boolean;
  activeWorkspaceId: string;
}

export async function resolvePageContext(): Promise<PageContext> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [isAdmin, ctx] = await Promise.all([isSuperAdmin(session.user.id), resolveWorkspaceContext()]);

  return {
    userId: session.user.id,
    userName: session.user.name ?? "",
    userEmail: session.user.email ?? "",
    isSuperAdmin: isAdmin,
    activeWorkspaceId: ctx.activeWorkspaceId,
  };
}

/**
 * Reuses the same context-resolution logic the API routes use (see
 * auth/workspace-context.middleware.ts), fed a pseudo-request built from the
 * current server request's cookies/headers, so the server-rendered shell and
 * every client fetch agree on which workspace is active from the very first
 * paint (no flash of the wrong workspace).
 */
async function resolveWorkspaceContext() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const pseudoRequest = {
    cookies: { get: (name: string) => cookieStore.get(name) },
    headers: { get: (name: string) => headerStore.get(name) },
  } as unknown as NextRequest;

  return resolveRequestContext(pseudoRequest);
}
