"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, CornerDownRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "ARCHIVED";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  parentTaskId: string | null;
  dueDate: string | null;
  assignee?: { id: string; fullName: string; avatarUrl?: string | null } | null;
}

const GROUPS: { id: TaskStatus; label: string }[] = [
  { id: "BACKLOG", label: "Backlog" },
  { id: "TODO", label: "To Do" },
  { id: "IN_PROGRESS", label: "In Progress" },
  { id: "IN_REVIEW", label: "In Review" },
  { id: "DONE", label: "Done" },
];

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  LOW: "bg-slate-200 text-slate-700",
  MEDIUM: "bg-blue-100 text-blue-700",
  HIGH: "bg-amber-100 text-amber-700",
  URGENT: "bg-red-100 text-red-700",
};

async function fetchTasks(projectId: string): Promise<TaskRow[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load tasks");
  return res.json();
}

async function createTask(projectId: string, title: string, parentTaskId?: string) {
  const res = await fetch(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, parentTaskId }),
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to create task");
  return res.json();
}

export default function TaskListView({
  projectId,
  onTaskClick,
}: {
  projectId: string;
  onTaskClick?: (taskId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(new Set());
  const [quickAddGroup, setQuickAddGroup] = useState<TaskStatus | null>(null);
  const [quickAddTitle, setQuickAddTitle] = useState("");

  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => fetchTasks(projectId),
  });

  const createMutation = useMutation({
    mutationFn: (title: string) => createTask(projectId, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      setQuickAddTitle("");
      setQuickAddGroup(null);
    },
  });

  const grouped = useMemo(() => {
    const byStatus = new Map<TaskStatus, TaskRow[]>(GROUPS.map((g) => [g.id, []]));
    // Top-level tasks only in the main grouping — subtasks render nested
    // under their parent within whichever group the parent falls into.
    const topLevel = tasks.filter((t) => !t.parentTaskId);
    const subtasksByParent = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      if (t.parentTaskId) {
        if (!subtasksByParent.has(t.parentTaskId)) subtasksByParent.set(t.parentTaskId, []);
        subtasksByParent.get(t.parentTaskId)!.push(t);
      }
    }
    for (const t of topLevel) byStatus.get(t.status)?.push(t);
    return { byStatus, subtasksByParent };
  }, [tasks]);

  function toggleGroup(status: TaskStatus) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {GROUPS.map((group) => {
        const groupTasks = grouped.byStatus.get(group.id) ?? [];
        const isCollapsed = collapsed.has(group.id);
        return (
          <div key={group.id} className="rounded-lg border">
            <button
              onClick={() => toggleGroup(group.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-sm font-semibold">{group.label}</span>
              <span className="text-xs text-muted-foreground">{groupTasks.length}</span>
            </button>

            {!isCollapsed && (
              <div className="divide-y border-t">
                {groupTasks.map((task) => (
                  <div key={task.id}>
                    <TaskRowView task={task} onClick={() => onTaskClick?.(task.id)} />
                    {(grouped.subtasksByParent.get(task.id) ?? []).map((sub) => (
                      <TaskRowView
                        key={sub.id}
                        task={sub}
                        indent
                        onClick={() => onTaskClick?.(sub.id)}
                      />
                    ))}
                  </div>
                ))}

                {quickAddGroup === group.id ? (
                  <form
                    className="flex items-center gap-2 px-3 py-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (quickAddTitle.trim()) createMutation.mutate(quickAddTitle.trim());
                    }}
                  >
                    <Input
                      autoFocus
                      value={quickAddTitle}
                      onChange={(e) => setQuickAddTitle(e.target.value)}
                      onBlur={() => !quickAddTitle && setQuickAddGroup(null)}
                      placeholder="Task name"
                      className="h-8"
                    />
                    <Button type="submit" size="sm" disabled={createMutation.isPending}>
                      Add
                    </Button>
                  </form>
                ) : (
                  <button
                    onClick={() => setQuickAddGroup(group.id)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add task
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TaskRowView({
  task,
  indent,
  onClick,
}: {
  task: TaskRow;
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50",
        indent && "pl-9"
      )}
    >
      {indent && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="flex-1 truncate">{task.title}</span>
      <Badge className={PRIORITY_COLOR[task.priority]} variant="secondary">
        {task.priority.toLowerCase()}
      </Badge>
      {task.dueDate && (
        <span className="w-20 shrink-0 text-xs text-muted-foreground">
          {new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
      )}
      {task.assignee ? (
        <Avatar className="h-6 w-6 shrink-0">
          <AvatarImage src={task.assignee.avatarUrl ?? undefined} />
          <AvatarFallback className="text-[10px]">
            {task.assignee.fullName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      ) : (
        <div className="h-6 w-6 shrink-0" />
      )}
    </div>
  );
}
