"use client";

import { useState, type ComponentType } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  LayoutTemplate,
  List,
  GanttChart as GanttChartIcon,
  FileText,
  Sparkles,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import AppSidebar from "@/components/AppSidebar";
import KanbanBoard from "@/components/KanbanBoard";
import TaskListView from "@/components/TaskListView";
import GanttChart from "@/components/GanttChart";
import TaskDetailPanel from "@/components/TaskDetailPanel";
import ProjectCollaboratorModal from "@/components/ProjectCollaboratorModal";
import ApplyTemplateDialog from "@/components/ApplyTemplateDialog";
import ReferencesTab from "@/components/ReferencesTab";
import AiReviewTab from "@/components/AiReviewTab";

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  client: { id: string; name: string } | null;
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

type ViewKey = "board" | "list" | "gantt" | "references" | "ai-review";

const VIEWS: { key: ViewKey; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: "board", label: "Board", icon: LayoutGrid },
  { key: "list", label: "List", icon: List },
  { key: "gantt", label: "Gantt", icon: GanttChartIcon },
  { key: "references", label: "References", icon: FileText },
  { key: "ai-review", label: "AI Review", icon: Sparkles },
];

export default function ProjectShell({
  projectId,
  activeWorkspaceId,
  userName,
  isSuperAdmin,
}: {
  projectId: string;
  activeWorkspaceId: string;
  userName: string;
  isSuperAdmin?: boolean;
}) {
  const { data: session } = useSession();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [collaboratorModalOpen, setCollaboratorModalOpen] = useState(false);
  const [applyTemplateOpen, setApplyTemplateOpen] = useState(false);
  const [activeView, setActiveView] = useState<ViewKey>("board");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    <div className="flex min-h-screen">
      <AppSidebar activeWorkspaceId={activeWorkspaceId} userName={userName} isSuperAdmin={isSuperAdmin} />
      <div className="flex min-h-screen flex-1 flex-col">
      <header className="flex items-center justify-between border-b-2 border-b-gold px-6 py-3">
        <div className="flex items-center gap-3">
          <div>
            {project?.client && (
              <p className="text-xs font-medium text-muted-foreground">{project.client.name}</p>
            )}
            <h1 className="font-semibold">{project?.name ?? "Project"}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setApplyTemplateOpen(true)}>
            <LayoutTemplate className="mr-1.5 h-4 w-4" />
            Apply template
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCollaboratorModalOpen(true)}>
            <Users className="mr-1.5 h-4 w-4" />
            Collaborators
          </Button>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Collapsible view-switcher sidebar — replaces the old horizontal
            tab bar now that there are 5 views; collapsing to icon-only
            keeps the board/list/gantt views from feeling cramped on
            smaller screens. */}
        <aside
          className={cn(
            "flex shrink-0 flex-col gap-1 border-r bg-muted/20 p-2 transition-all",
            sidebarCollapsed ? "w-14" : "w-48"
          )}
        >
          {VIEWS.map((view) => {
            const Icon = view.icon;
            const active = activeView === view.key;
            return (
              <button
                key={view.key}
                onClick={() => setActiveView(view.key)}
                title={sidebarCollapsed ? view.label : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-gold text-gold-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!sidebarCollapsed && <span className="truncate">{view.label}</span>}
              </button>
            );
          })}

          <div className="mt-auto pt-2">
            <button
              onClick={() => setSidebarCollapsed((v) => !v)}
              className="flex w-full items-center justify-center gap-2 rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {sidebarCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
              {!sidebarCollapsed && <span>Collapse</span>}
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-x-auto px-6 py-4">
          {activeView === "board" && <KanbanBoard projectId={projectId} onTaskClick={setSelectedTaskId} />}
          {activeView === "list" && <TaskListView projectId={projectId} onTaskClick={setSelectedTaskId} />}
          {activeView === "gantt" && <GanttChart projectId={projectId} onTaskClick={setSelectedTaskId} />}
          {activeView === "references" && <ReferencesTab projectId={projectId} />}
          {activeView === "ai-review" && <AiReviewTab projectId={projectId} />}
        </main>
      </div>

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

      <ApplyTemplateDialog projectId={projectId} open={applyTemplateOpen} onOpenChange={setApplyTemplateOpen} />
      </div>
    </div>
  );
}
