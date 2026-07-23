"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { io, Socket } from "socket.io-client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface TaskCard {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  assignee?: { id: string; fullName: string; avatarUrl?: string | null } | null;
}

const COLUMNS: { id: TaskStatus; label: string }[] = [
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

async function fetchTasks(projectId: string): Promise<TaskCard[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load tasks");
  return res.json();
}

async function moveTask(
  projectId: string,
  taskId: string,
  status: TaskStatus,
  position: number
) {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, position }),
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to move task");
}

/**
 * Fractional-index helper: pick a position value strictly between the two
 * neighbors so we never have to rewrite the whole column on a reorder.
 */
function positionBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

export default function KanbanBoard({
  projectId,
  onTaskClick,
}: {
  projectId: string;
  onTaskClick?: (taskId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [activeTask, setActiveTask] = useState<TaskCard | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => fetchTasks(projectId),
  });

  // --- Realtime: reflect moves made by other collaborators instantly ---
  useEffect(() => {
    const s = io(process.env.NEXT_PUBLIC_WS_URL!, {
      withCredentials: true,
      query: { projectId },
    });
    s.on("task:moved", (payload: { taskId: string; status: TaskStatus; position: number }) => {
      queryClient.setQueryData<TaskCard[]>(["tasks", projectId], (old = []) =>
        old.map((t) =>
          t.id === payload.taskId ? { ...t, status: payload.status, position: payload.position } : t
        )
      );
    });
    s.on("task:created", () => queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }));
    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, [projectId, queryClient]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const columns = useMemo(() => {
    const byStatus = new Map<TaskStatus, TaskCard[]>(COLUMNS.map((c) => [c.id, []]));
    for (const t of tasks) byStatus.get(t.status)?.push(t);
    for (const list of byStatus.values()) list.sort((a, b) => a.position - b.position);
    return byStatus;
  }, [tasks]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((t) => t.id === event.active.id);
      setActiveTask(task ?? null);
    },
    [tasks]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = String(active.id);
      const targetStatus = String(over.data.current?.status ?? over.id) as TaskStatus;
      const targetColumn = columns.get(targetStatus) ?? [];
      const overIndex = targetColumn.findIndex((t) => t.id === over.id);

      const before = overIndex > 0 ? targetColumn[overIndex - 1]?.position : undefined;
      const after = overIndex >= 0 ? targetColumn[overIndex]?.position : targetColumn.at(-1)?.position;
      const newPosition = positionBetween(before, after);

      // Optimistic update — the server-authoritative value arrives via the
      // `task:moved` socket event and reconciles automatically.
      queryClient.setQueryData<TaskCard[]>(["tasks", projectId], (old = []) =>
        old.map((t) => (t.id === taskId ? { ...t, status: targetStatus, position: newPosition } : t))
      );

      try {
        await moveTask(projectId, taskId, targetStatus, newPosition);
        socket?.emit("task:move", { taskId, status: targetStatus, position: newPosition });
      } catch {
        queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }); // rollback via refetch
      }
    },
    [columns, projectId, queryClient, socket]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            status={col.id}
            label={col.label}
            tasks={columns.get(col.id) ?? []}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>
      <DragOverlay>{activeTask && <TaskCardView task={activeTask} />}</DragOverlay>
    </DndContext>
  );
}

function KanbanColumn({
  status,
  label,
  tasks,
  onTaskClick,
}: {
  status: TaskStatus;
  label: string;
  tasks: TaskCard[];
  onTaskClick?: (taskId: string) => void;
}) {
  return (
    <div className="w-72 shrink-0 rounded-lg bg-muted/50 p-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-sm font-semibold">{label}</h3>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2 min-h-[4px]" data-status={status} id={status}>
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} onTaskClick={onTaskClick} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableTaskCard({
  task,
  onTaskClick,
}: {
  task: TaskCard;
  onTaskClick?: (taskId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { status: task.status },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} onClick={() => onTaskClick?.(task.id)}>
      <TaskCardView task={task} />
    </div>
  );
}

function TaskCardView({ task }: { task: TaskCard }) {
  return (
    <Card className="cursor-grab active:cursor-grabbing">
      <CardContent className="p-3">
        <p className="text-sm font-medium leading-snug">{task.title}</p>
        <div className="mt-2 flex items-center justify-between">
          <Badge className={PRIORITY_COLOR[task.priority]} variant="secondary">
            {task.priority.toLowerCase()}
          </Badge>
          {task.assignee && (
            <Avatar className="h-6 w-6">
              <AvatarImage src={task.assignee.avatarUrl ?? undefined} />
              <AvatarFallback className="text-[10px]">
                {task.assignee.fullName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
