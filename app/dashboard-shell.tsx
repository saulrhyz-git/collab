"use client";

import { useState, type ComponentType } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import {
  Plus,
  Folder,
  Lock,
  Globe,
  Briefcase,
  ListChecks,
  CalendarClock,
  AlertTriangle,
  Clock,
  Building2,
  ShieldCheck,
} from "lucide-react";
import WorkspaceSelector from "@/components/WorkspaceSelector";
import CreateProjectDialog from "@/components/CreateProjectDialog";
import CreateClientDialog from "@/components/CreateClientDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatRelativeTime, formatDueLabel } from "@/lib/utils";
import { formatActivity } from "@/lib/format-activity";

type Visibility = "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface EngagementProject {
  id: string;
  name: string;
  visibility: Visibility;
  total: number;
  done: number;
  overdue: number;
}

interface ClientGroup {
  id: string;
  name: string;
  projects: EngagementProject[];
}

interface MyTask {
  id: string;
  title: string;
  status: string;
  priority: Priority;
  dueDate: string | null;
  projectId: string;
  projectName: string;
}

interface UpcomingDeadline {
  id: string;
  title: string;
  dueDate: string;
  projectId: string;
  projectName: string;
  assignee: { id: string; fullName: string; avatarUrl: string | null } | null;
}

interface ActivityItem {
  id: string;
  action: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  actorName: string;
  projectName: string | null;
}

interface DashboardData {
  stats: { activeEngagements: number; myOpenTasks: number; dueThisWeek: number; overdue: number };
  myTasks: MyTask[];
  upcomingDeadlines: UpcomingDeadline[];
  recentActivity: ActivityItem[];
  clients: ClientGroup[];
  unclientedProjects: EngagementProject[];
}

interface WorkspaceSummary {
  id: string;
  name: string;
  type: "PERSONAL" | "SHARED";
}

const PRIORITY_COLOR: Record<Priority, string> = {
  LOW: "bg-slate-200 text-slate-700",
  MEDIUM: "bg-blue-100 text-blue-700",
  HIGH: "bg-amber-100 text-amber-700",
  URGENT: "bg-red-100 text-red-700",
};

async function fetchDashboard(workspaceId: string): Promise<DashboardData> {
  const res = await fetch(`/api/workspaces/${workspaceId}/dashboard`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load dashboard");
  return res.json();
}

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await fetch("/api/workspaces", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load workspaces");
  return res.json();
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Post-login landing page. Answers "what's going on" at a glance: quick
 * stats, what's on my plate, what's coming due for anyone, recent team
 * activity, and the full roster of clients/engagements — rather than
 * dropping the person on a bare project grid.
 */
export default function DashboardShell({
  activeWorkspaceId,
  userName,
  isSuperAdmin,
}: {
  activeWorkspaceId: string;
  userName: string;
  isSuperAdmin?: boolean;
}) {
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createClientOpen, setCreateClientOpen] = useState(false);

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ["dashboard", activeWorkspaceId],
    queryFn: () => fetchDashboard(activeWorkspaceId),
  });

  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const firstName = userName.split(" ")[0] || userName;
  const totalProjects = dashboard
    ? dashboard.clients.reduce((n, c) => n + c.projects.length, 0) + dashboard.unclientedProjects.length
    : 0;

  return (
    <div className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between border-b-2 border-b-gold bg-background px-6 py-3">
        <WorkspaceSelector activeWorkspaceId={activeWorkspaceId} />
        <div className="flex items-center gap-3">
          {isSuperAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <ShieldCheck className="mr-1.5 h-4 w-4 text-gold" />
                  Admin
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/admin/permissions">Permissions matrix</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/admin/custom-roles">Custom roles</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/admin/users">Users</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/admin/task-templates">Task templates</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/admin/engagement-types">Engagement types</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/admin/smtp-settings">SMTP settings</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/admin/ai-provider-settings">AI provider settings</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="text-sm text-muted-foreground">{userName}</span>
          <Button variant="outline" size="sm" onClick={() => signOut({ callbackUrl: "/login" })}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              {getGreeting()}, {firstName}
            </h1>
            <p className="text-sm text-muted-foreground">
              {activeWorkspace
                ? `Here's what's happening in ${activeWorkspace.name}.`
                : "Here's what's happening."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreateClientOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New client
            </Button>
            <Button size="sm" onClick={() => setCreateProjectOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New engagement
            </Button>
          </div>
        </div>

        {isLoading || !dashboard ? (
          <p className="text-sm text-muted-foreground">Loading your workspace…</p>
        ) : totalProjects === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <Folder className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">Nothing here yet</p>
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                  Create an engagement to get a Board, List, and Gantt view for tracking the work,
                  plus the ability to invite collaborators. If you're working with an external
                  client, log them first so every engagement rolls up under their name.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setCreateClientOpen(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  New client
                </Button>
                <Button size="sm" onClick={() => setCreateProjectOpen(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  New engagement
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard icon={Briefcase} label="Active engagements" value={dashboard.stats.activeEngagements} />
              <StatCard icon={ListChecks} label="My open tasks" value={dashboard.stats.myOpenTasks} />
              <StatCard
                icon={CalendarClock}
                label="Due this week"
                value={dashboard.stats.dueThisWeek}
                tone={dashboard.stats.dueThisWeek > 0 ? "warn" : "default"}
              />
              <StatCard
                icon={AlertTriangle}
                label="Overdue"
                value={dashboard.stats.overdue}
                tone={dashboard.stats.overdue > 0 ? "danger" : "default"}
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <MyTasksCard tasks={dashboard.myTasks} />
                <UpcomingDeadlinesCard items={dashboard.upcomingDeadlines} />
              </div>
              <RecentActivityCard items={dashboard.recentActivity} />
            </div>

            <div>
              <h2 className="mb-3 text-lg font-semibold">Clients & engagements</h2>
              <div className="space-y-5">
                {dashboard.clients.map((c) => (
                  <ClientGroupCard key={c.id} id={c.id} name={c.name} projects={c.projects} />
                ))}
                {dashboard.unclientedProjects.length > 0 && (
                  <ClientGroupCard
                    name="Internal / no client"
                    projects={dashboard.unclientedProjects}
                    muted
                  />
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <CreateProjectDialog workspaceId={activeWorkspaceId} open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
      <CreateClientDialog workspaceId={activeWorkspaceId} open={createClientOpen} onOpenChange={setCreateClientOpen} />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            tone === "danger" && "bg-red-100 text-red-600",
            tone === "warn" && "bg-amber-100 text-amber-600",
            tone === "default" && "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xl font-semibold leading-none">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function MyTasksCard({ tasks }: { tasks: MyTask[] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          My tasks
        </h3>
        {tasks.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing assigned to you right now.
          </p>
        ) : (
          <div className="divide-y">
            {tasks.map((t) => {
              const due = t.dueDate ? formatDueLabel(t.dueDate) : null;
              return (
                <Link
                  key={t.id}
                  href={`/projects/${t.projectId}`}
                  className="flex items-center gap-3 py-2 text-sm hover:bg-accent/50"
                >
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                    {t.projectName}
                  </span>
                  <Badge className={cn(PRIORITY_COLOR[t.priority], "shrink-0")} variant="secondary">
                    {t.priority.toLowerCase()}
                  </Badge>
                  {due && (
                    <span className={cn("w-24 shrink-0 text-right text-xs", due.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
                      {due.label}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UpcomingDeadlinesCard({ items }: { items: UpcomingDeadline[] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          Upcoming deadlines
        </h3>
        {items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing due across the workspace in the next two weeks.
          </p>
        ) : (
          <div className="divide-y">
            {items.map((t) => {
              const due = formatDueLabel(t.dueDate);
              return (
                <Link
                  key={t.id}
                  href={`/projects/${t.projectId}`}
                  className="flex items-center gap-3 py-2 text-sm hover:bg-accent/50"
                >
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                    {t.projectName}
                  </span>
                  <span className={cn("w-24 shrink-0 text-right text-xs", due.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
                    {due.label}
                  </span>
                  {t.assignee ? (
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarImage src={t.assignee.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-[10px]">
                        {t.assignee.fullName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  ) : (
                    <div className="h-6 w-6 shrink-0" />
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentActivityCard({ items }: { items: ActivityItem[] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Recent activity
        </h3>
        {items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((a) => (
              <li key={a.id} className="text-sm">
                <p className="leading-snug text-foreground/90">
                  {formatActivity(a.action, a.metadata, a.actorName, a.projectName)}
                </p>
                <p className="text-xs text-muted-foreground">{formatRelativeTime(a.timestamp)}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ClientGroupCard({
  id,
  name,
  projects,
  muted,
}: {
  id?: string;
  name: string;
  projects: EngagementProject[];
  muted?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
          <Building2 className={cn("h-4 w-4", muted ? "text-muted-foreground/60" : "text-muted-foreground")} />
          {id ? (
            <Link href={`/clients/${id}`} className={cn("hover:underline", muted ? "text-muted-foreground" : "")}>
              {name}
            </Link>
          ) : (
            <span className={muted ? "text-muted-foreground" : ""}>{name}</span>
          )}
          <span className="text-xs font-normal text-muted-foreground">
            {projects.length} engagement{projects.length === 1 ? "" : "s"}
          </span>
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectMiniCard key={p.id} project={p} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectMiniCard({ project }: { project: EngagementProject }) {
  const pct = project.total > 0 ? Math.round((project.done / project.total) * 100) : 0;
  return (
    <Link href={`/projects/${project.id}`}>
      <div className="h-full rounded-md border p-3 transition-colors hover:bg-accent/50">
        <div className="mb-1.5 flex items-center gap-1.5">
          {project.visibility === "PRIVATE_TO_MEMBERS" ? (
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{project.name}</span>
        </div>
        <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {project.done}/{project.total} tasks done
          </span>
          {project.overdue > 0 && (
            <span className="font-medium text-destructive">{project.overdue} overdue</span>
          )}
        </div>
      </div>
    </Link>
  );
}
