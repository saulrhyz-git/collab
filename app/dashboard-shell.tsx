"use client";

import { signOut } from "next-auth/react";
import WorkspaceSelector from "@/components/WorkspaceSelector";
import { Button } from "@/components/ui/button";

/**
 * Top-level authenticated shell. This is intentionally minimal — a real
 * build would route to /workspaces/:id/projects/:id for the Kanban board
 * (components/KanbanBoard.tsx) and project settings (ProjectCollaboratorModal),
 * both of which are already implemented and just need pages wired to them.
 */
export default function DashboardShell({
  activeWorkspaceId,
  userName,
}: {
  activeWorkspaceId: string;
  userName: string;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <WorkspaceSelector activeWorkspaceId={activeWorkspaceId} />
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{userName}</span>
          <Button variant="outline" size="sm" onClick={() => signOut({ callbackUrl: "/login" })}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a project to see its board.
      </main>
    </div>
  );
}
