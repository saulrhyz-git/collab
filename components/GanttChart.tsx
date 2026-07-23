"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "ARCHIVED";

interface GanttTask {
  id: string;
  title: string;
  status: TaskStatus;
  parentTaskId: string | null;
  startDate: string | null;
  dueDate: string | null;
  position: number;
}

interface Dependency {
  id: string;
  predecessorTaskId: string;
  successorTaskId: string;
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  BACKLOG: "bg-slate-300",
  TODO: "bg-slate-400",
  IN_PROGRESS: "bg-blue-500",
  IN_REVIEW: "bg-amber-500",
  DONE: "bg-emerald-500",
  ARCHIVED: "bg-slate-300",
};

const ROW_HEIGHT = 40;
const LABEL_WIDTH = 240;
const DAY_WIDTH = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchTasks(projectId: string): Promise<GanttTask[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load tasks");
  return res.json();
}

async function fetchDependencies(projectId: string): Promise<Dependency[]> {
  const res = await fetch(`/api/projects/${projectId}/dependencies`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load dependencies");
  return res.json();
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export default function GanttChart({
  projectId,
  onTaskClick,
}: {
  projectId: string;
  onTaskClick?: (taskId: string) => void;
}) {
  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => fetchTasks(projectId),
  });
  const { data: dependencies = [] } = useQuery({
    queryKey: ["dependencies", projectId],
    queryFn: () => fetchDependencies(projectId),
  });

  const scheduled = tasks.filter((t) => t.startDate || t.dueDate);
  const unscheduled = tasks.filter((t) => !t.startDate && !t.dueDate && !t.parentTaskId);

  const { rangeStart, numDays, rows } = useMemo(() => {
    const dates = scheduled.flatMap((t) => [t.startDate, t.dueDate].filter(Boolean) as string[]).map((d) => new Date(d));
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const min = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : today;
    const max = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : new Date(today.getTime() + 13 * DAY_MS);

    const rangeStart = new Date(min);
    rangeStart.setDate(rangeStart.getDate() - 2);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(max);
    rangeEnd.setDate(rangeEnd.getDate() + 2);

    const numDays = Math.max(daysBetween(rangeStart, rangeEnd) + 1, 14);

    // Top-level tasks (position order) followed immediately by their
    // subtasks — same hierarchy as TaskListView, just without status grouping
    // (a Gantt is inherently one chronological view, not columns).
    const topLevel = tasks.filter((t) => !t.parentTaskId).sort((a, b) => a.position - b.position);
    const byParent = new Map<string, GanttTask[]>();
    for (const t of tasks) {
      if (t.parentTaskId) {
        if (!byParent.has(t.parentTaskId)) byParent.set(t.parentTaskId, []);
        byParent.get(t.parentTaskId)!.push(t);
      }
    }
    const rows: { task: GanttTask; indent: boolean }[] = [];
    for (const t of topLevel) {
      rows.push({ task: t, indent: false });
      for (const sub of (byParent.get(t.id) ?? []).sort((a, b) => a.position - b.position)) {
        rows.push({ task: sub, indent: true });
      }
    }

    return { rangeStart, numDays, rows };
  }, [tasks, scheduled]);

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((r, i) => map.set(r.task.id, i));
    return map;
  }, [rows]);

  function xForDate(date: Date) {
    return daysBetween(rangeStart, date) * DAY_WIDTH;
  }

  const monthLabels = useMemo(() => {
    const labels: { x: number; label: string }[] = [];
    let lastMonth = -1;
    for (let i = 0; i < numDays; i++) {
      const d = new Date(rangeStart.getTime() + i * DAY_MS);
      if (d.getMonth() !== lastMonth) {
        labels.push({ x: i * DAY_WIDTH, label: d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) });
        lastMonth = d.getMonth();
      }
    }
    return labels;
  }, [rangeStart, numDays]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayX = xForDate(today);
  const timelineWidth = numDays * DAY_WIDTH;
  const timelineHeight = rows.length * ROW_HEIGHT;

  if (tasks.length === 0) {
    return <p className="px-1 py-8 text-center text-sm text-muted-foreground">No tasks yet — add one from the List or Board view.</p>;
  }

  return (
    <div className="rounded-lg border">
      <div className="overflow-x-auto">
        <div style={{ width: LABEL_WIDTH + timelineWidth }}>
          {/* Header */}
          <div className="flex border-b">
            <div className="sticky left-0 z-20 shrink-0 border-r bg-background" style={{ width: LABEL_WIDTH }} />
            <div className="relative shrink-0" style={{ width: timelineWidth, height: 28 }}>
              {monthLabels.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 border-l pl-1.5 text-xs text-muted-foreground"
                  style={{ left: m.x, height: 28, lineHeight: "28px" }}
                >
                  {m.label}
                </div>
              ))}
            </div>
          </div>

          {/* Rows + dependency/today overlay */}
          <div className="relative">
            <svg
              className="pointer-events-none absolute top-0 z-10"
              style={{ left: LABEL_WIDTH, width: timelineWidth, height: timelineHeight }}
            >
              {todayX >= 0 && todayX <= timelineWidth && (
                <line x1={todayX} y1={0} x2={todayX} y2={timelineHeight} stroke="hsl(var(--destructive))" strokeWidth={1} strokeDasharray="3,3" />
              )}
              {dependencies.map((dep) => {
                const predRow = rowIndexById.get(dep.predecessorTaskId);
                const succRow = rowIndexById.get(dep.successorTaskId);
                const pred = tasks.find((t) => t.id === dep.predecessorTaskId);
                const succ = tasks.find((t) => t.id === dep.successorTaskId);
                if (predRow === undefined || succRow === undefined || !pred || !succ) return null;
                const predEnd = pred.dueDate ?? pred.startDate;
                const succStart = succ.startDate ?? succ.dueDate;
                if (!predEnd || !succStart) return null;
                const x1 = xForDate(new Date(predEnd));
                const x2 = xForDate(new Date(succStart));
                const y1 = predRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                const y2 = succRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                const midX = x1 + (x2 - x1) / 2;
                return (
                  <path
                    key={dep.id}
                    d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
                    fill="none"
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth={1.5}
                  />
                );
              })}
            </svg>

            {rows.map(({ task, indent }) => {
              const start = task.startDate ? new Date(task.startDate) : task.dueDate ? new Date(task.dueDate) : null;
              const end = task.dueDate ? new Date(task.dueDate) : task.startDate ? new Date(task.startDate) : null;
              const hasBar = !!start && !!end;
              const barLeft = hasBar ? xForDate(start!) : 0;
              const barWidth = hasBar ? Math.max((daysBetween(start!, end!) + 1) * DAY_WIDTH - 4, 10) : 0;

              return (
                <div key={task.id} className="flex border-b last:border-b-0" style={{ height: ROW_HEIGHT }}>
                  <div
                    className={cn(
                      "sticky left-0 z-10 flex shrink-0 items-center gap-1.5 truncate border-r bg-background px-2 text-sm",
                      indent && "pl-7"
                    )}
                    style={{ width: LABEL_WIDTH }}
                  >
                    {indent && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{task.title}</span>
                  </div>
                  <div className="relative shrink-0" style={{ width: timelineWidth }}>
                    {hasBar && (
                      <button
                        onClick={() => onTaskClick?.(task.id)}
                        className={cn(
                          "absolute top-1/2 h-5 -translate-y-1/2 rounded text-left text-[11px] text-white shadow-sm",
                          STATUS_COLOR[task.status]
                        )}
                        style={{ left: barLeft + 2, width: barWidth }}
                        title={task.title}
                      >
                        <span className="ml-1.5 truncate leading-5">{task.title}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {unscheduled.length} task{unscheduled.length === 1 ? "" : "s"} without dates —{" "}
          {unscheduled.map((t, i) => (
            <span key={t.id}>
              <button className="underline underline-offset-2 hover:text-foreground" onClick={() => onTaskClick?.(t.id)}>
                {t.title}
              </button>
              {i < unscheduled.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
