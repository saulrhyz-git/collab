"use client";

import { useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Folder, Lock, Globe } from "lucide-react";
import WorkspaceSelector from "@/components/WorkspaceSelector";
import CreateProjectDialog from "@/components/CreateProjectDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  visibility: "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS";
  createdAt: string;
}

async function fetchProjects(workspaceId: string): Promise<ProjectSummary[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/projects`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load projects");
  return res.json();
}

/**
 * Top-level authenticated shell — the workspace switcher plus a project
 * list for whichever workspace is active. Every account's default
 * (personal) workspace lands here immediately after signup with an empty
 * project list and a prominent "New project" affordance, rather than a
 * dead end.
 */
export default function DashboardShell({
  activeWorkspaceId,
  userName,
}: {
  activeWorkspaceId: string;
  userName: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects", activeWorkspaceId],
    queryFn: () => fetchProjects(activeWorkspaceId),
  });

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

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Projects</h1>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New project
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : projects.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <Folder className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">No projects yet</p>
                <p className="text-sm text-muted-foreground">
                  Create one to get a Board, List, and Gantt view, plus the ability to invite collaborators.
                </p>
              </div>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New project
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="h-full transition-colors hover:bg-accent/50">
                  <CardContent className="p-4">
                    <div className="mb-1 flex items-center gap-2">
                      {p.visibility === "PRIVATE_TO_MEMBERS" ? (
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <h3 className="truncate font-medium">{p.name}</h3>
                    </div>
                    {p.description && (
                      <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>

      <CreateProjectDialog workspaceId={activeWorkspaceId} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
