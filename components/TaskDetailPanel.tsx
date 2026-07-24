"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Share2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import TaskCollaboratorsModal from "@/components/TaskCollaboratorsModal";

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "ARCHIVED";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  startDate: string | null;
  dueDate: string | null;
  assigneeId: string | null;
  assignee: { id: string; fullName: string; avatarUrl?: string | null } | null;
  reporter: { id: string; fullName: string; avatarUrl?: string | null } | null;
  subtasks: { id: string; title: string; status: TaskStatus }[];
  blockedBy: { id: string; taskId: string; title: string; status: TaskStatus }[];
  blocks: { id: string; taskId: string; title: string; status: TaskStatus }[];
}

interface Comment {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
}

interface ProjectMember {
  userId: string;
  fullName: string;
}

async function fetchTask(projectId: string, taskId: string): Promise<TaskDetail> {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load task");
  return res.json();
}

async function fetchComments(projectId: string, taskId: string): Promise<Comment[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/comments`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load comments");
  return res.json();
}

async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
  const res = await fetch(`/api/projects/${projectId}/members`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

async function fetchProjectTasks(projectId: string) {
  const res = await fetch(`/api/projects/${projectId}/tasks`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load tasks");
  return res.json() as Promise<{ id: string; title: string }[]>;
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

export default function TaskDetailPanel({
  projectId,
  taskId,
  currentUserRole,
  onClose,
}: {
  projectId: string;
  taskId: string;
  currentUserRole: "PROJECT_ADMIN" | "EDITOR" | "VIEWER";
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const canEdit = currentUserRole === "PROJECT_ADMIN" || currentUserRole === "EDITOR";

  const { data: task } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => fetchTask(projectId, taskId),
  });
  const { data: comments = [] } = useQuery({
    queryKey: ["task-comments", taskId],
    queryFn: () => fetchComments(projectId, taskId),
  });
  const { data: members = [] } = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => fetchMembers(projectId),
  });
  const { data: allTasks = [] } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => fetchProjectTasks(projectId),
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [newComment, setNewComment] = useState("");
  const [addingDependency, setAddingDependency] = useState(false);
  const [dependencyTaskId, setDependencyTaskId] = useState("");
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? "");
    }
  }, [task]);

  function invalidateTask() {
    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
  }

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetch(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      }).then((res) => {
        if (!res.ok) throw new Error("Failed to update task");
        return res.json();
      }),
    onSuccess: invalidateTask,
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) =>
      fetch(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        credentials: "include",
      }).then((res) => {
        if (!res.ok) throw new Error("Failed to post comment");
        return res.json();
      }),
    onSuccess: () => {
      setNewComment("");
      queryClient.invalidateQueries({ queryKey: ["task-comments", taskId] });
    },
  });

  const addDependencyMutation = useMutation({
    mutationFn: (predecessorTaskId: string) =>
      fetch(`/api/projects/${projectId}/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ predecessorTaskId }),
        credentials: "include",
      }).then((res) => {
        if (!res.ok) return res.json().then((b) => Promise.reject(new Error(b.error ?? "Failed")));
        return res.json();
      }),
    onSuccess: () => {
      setAddingDependency(false);
      setDependencyTaskId("");
      invalidateTask();
    },
  });

  const removeDependencyMutation = useMutation({
    mutationFn: (dependencyId: string) =>
      fetch(`/api/projects/${projectId}/tasks/${taskId}/dependencies/${dependencyId}`, {
        method: "DELETE",
        credentials: "include",
      }),
    onSuccess: invalidateTask,
  });

  if (!task) return null;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader className="flex-row items-start justify-between gap-2 space-y-0">
          {canEdit ? (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== task.title && updateMutation.mutate({ title })}
              className="border-none px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
            />
          ) : (
            <SheetTitle>{task.title}</SheetTitle>
          )}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setCollaboratorsOpen(true)}>
            <Share2 className="mr-1.5 h-3.5 w-3.5" />
            Share
          </Button>
        </SheetHeader>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Status">
            <Select
              disabled={!canEdit}
              value={task.status}
              onValueChange={(v) => updateMutation.mutate({ status: v })}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "ARCHIVED"].map((s) => (
                  <SelectItem key={s} value={s}>{s.replace("_", " ").toLowerCase()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Priority">
            <Select
              disabled={!canEdit}
              value={task.priority}
              onValueChange={(v) => updateMutation.mutate({ priority: v })}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["LOW", "MEDIUM", "HIGH", "URGENT"].map((p) => (
                  <SelectItem key={p} value={p}>{p.toLowerCase()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Assignee">
            <Select
              disabled={!canEdit}
              value={task.assigneeId ?? "__none"}
              onValueChange={(v) => updateMutation.mutate({ assigneeId: v === "__none" ? null : v })}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Unassigned</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>{m.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Reporter">
            <div className="flex h-8 items-center gap-1.5 text-muted-foreground">
              {task.reporter?.fullName ?? "—"}
            </div>
          </Field>

          <Field label="Start date">
            <Input
              type="date"
              disabled={!canEdit}
              className="h-8"
              defaultValue={toDateInputValue(task.startDate)}
              onBlur={(e) => updateMutation.mutate({ startDate: e.target.value || null })}
            />
          </Field>

          <Field label="Due date">
            <Input
              type="date"
              disabled={!canEdit}
              className="h-8"
              defaultValue={toDateInputValue(task.dueDate)}
              onBlur={(e) => updateMutation.mutate({ dueDate: e.target.value || null })}
            />
          </Field>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Description</p>
          <Textarea
            disabled={!canEdit}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== (task.description ?? "") && updateMutation.mutate({ description })}
            rows={4}
            placeholder="Add a description…"
          />
        </div>

        {task.subtasks.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Subtasks</p>
            <div className="space-y-1">
              {task.subtasks.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded border px-2 py-1 text-sm">
                  <span className="truncate">{s.title}</span>
                  <Badge variant="secondary">{s.status.replace("_", " ").toLowerCase()}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Dependencies</p>
            {canEdit && (
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setAddingDependency(true)}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {addingDependency && (
            <div className="mb-2 flex items-center gap-2">
              <Select value={dependencyTaskId} onValueChange={setDependencyTaskId}>
                <SelectTrigger className="h-8"><SelectValue placeholder="Blocked by…" /></SelectTrigger>
                <SelectContent>
                  {allTasks.filter((t) => t.id !== taskId).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!dependencyTaskId || addDependencyMutation.isPending}
                onClick={() => addDependencyMutation.mutate(dependencyTaskId)}
              >
                Add
              </Button>
            </div>
          )}

          {task.blockedBy.length > 0 && (
            <div className="mb-1 space-y-1">
              <p className="text-xs text-muted-foreground">Blocked by</p>
              {task.blockedBy.map((d) => (
                <DependencyRow key={d.id} title={d.title} onRemove={() => removeDependencyMutation.mutate(d.id)} />
              ))}
            </div>
          )}
          {task.blocks.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Blocks</p>
              {task.blocks.map((d) => (
                <DependencyRow key={d.id} title={d.title} onRemove={() => removeDependencyMutation.mutate(d.id)} />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Comments</p>
          <div className="flex-1 space-y-3 overflow-y-auto">
            {comments.map((c) => (
              <div key={c.id} className="flex gap-2">
                <Avatar className="h-6 w-6 shrink-0">
                  <AvatarImage src={c.authorAvatar ?? undefined} />
                  <AvatarFallback className="text-[10px]">{c.authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{c.authorName}</p>
                  <p className="whitespace-pre-wrap break-words text-sm">{c.body}</p>
                </div>
              </div>
            ))}
            {comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
          </div>

          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newComment.trim()) commentMutation.mutate(newComment.trim());
            }}
          >
            <Input
              placeholder="Write a comment…"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={commentMutation.isPending}>
              Post
            </Button>
          </form>
        </div>
      </SheetContent>

      <TaskCollaboratorsModal
        projectId={projectId}
        taskId={taskId}
        open={collaboratorsOpen}
        onOpenChange={setCollaboratorsOpen}
      />
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function DependencyRow({ title, onRemove }: { title: string; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between rounded border px-2 py-1 text-sm">
      <span className="truncate">{title}</span>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
