"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Users } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import KanbanBoard from "@/components/KanbanBoard";
import TaskListView from "@/components/TaskListView";
import GanttChart from "@/components/GanttChart";
import TaskDetailPanel from "@/components/TaskDetailPanel";
import ProjectCollaboratorModal from "@/components/ProjectCollaboratorModal";

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
}

async function fetchProject(projectId: string): Promise<ProjectDetail> {
  const res = await fetch(`/api/projects/${projectId}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load project");
  return res.json();
}

interface MemberRow {
  userId: string;
  role: "PROJECT_ADMIN" | "EDITOR" | "VIEWER";
}

async function fetchMembers(projectId: string): Promise<MemberRow[]> {
  const res = await fetch(`/api/projects/${projectId}/members`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

export default function ProjectShell({ projectId }: { projectId: string }) {
  const { data: session } = useSession();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [collaboratorModalOpen, setCollaboratorModalOpen] = useState(false);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
  });

  const { data: members = [] } = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => fetchMembers(projectId),
  });

  const currentUserRole =
    members.find((m) => m.userId === session?.user?.id)?.role ?? "VIEWER";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="font-semibold">{project?.name ?? "Project"}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => setCollaboratorModalOpen(true)}>
          <Users className="mr-1.5 h-4 w-4" />
          Collaborators
        </Button>
      </header>

      <main className="flex-1 px-6 py-4">
        <Tabs defaultValue="board">
          <TabsList>
            <TabsTrigger value="board">Board</TabsTrigger>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="gantt">Gantt</TabsTrigger>
          </TabsList>

          <TabsContent value="board">
            <KanbanBoard projectId={projectId} onTaskClick={setSelectedTaskId} />
          </TabsContent>
          <TabsContent value="list">
            <TaskListView projectId={projectId} onTaskClick={setSelectedTaskId} />
          </TabsContent>
          <TabsContent value="gantt">
            <GanttChart projectId={projectId} onTaskClick={setSelectedTaskId} />
          </TabsContent>
        </Tabs>
      </main>

      {selectedTaskId && (
        <TaskDetailPanel
          projectId={projectId}
          taskId={selectedTaskId}
          currentUserRole={currentUserRole}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      <ProjectCollaboratorModal
        projectId={projectId}
        open={collaboratorModalOpen}
        onOpenChange={setCollaboratorModalOpen}
        currentUserRole={currentUserRole}
      />
    </div>
  );
}
