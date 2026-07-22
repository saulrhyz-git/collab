import { redirect } from "next/navigation";
import { auth } from "../auth";
import { resolveRequestContext } from "../auth/workspace-context.middleware";
import DashboardShell from "./dashboard-shell";
import { headers, cookies } from "next/headers";
import { NextRequest } from "next/server";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Reuse the same context-resolution logic the API routes use, so the
  // server-rendered shell and every client fetch agree on which workspace
  // is active from the very first paint (no flash of the wrong workspace).
  const cookieStore = await cookies();
  const headerStore = await headers();
  const pseudoRequest = {
    cookies: { get: (name: string) => cookieStore.get(name) },
    headers: { get: (name: string) => headerStore.get(name) },
  } as unknown as NextRequest;

  const ctx = await resolveRequestContext(pseudoRequest);

  return <DashboardShell activeWorkspaceId={ctx.activeWorkspaceId} userName={session.user.name ?? ""} />;
}
