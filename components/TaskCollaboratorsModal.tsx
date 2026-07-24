"use client";

/**
 * True task-level ACL — grants VIEWER/EDITOR on exactly this one task,
 * without any visibility into the rest of the engagement's backlog. Kept
 * deliberately simple (no custom-role picker, just the two levels — see
 * db/schema.ts's task_members comment) compared to ClientCollaboratorsModal
 * / ProjectCollaboratorModal.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, UserPlus, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

type TaskMemberRole = "VIEWER" | "EDITOR";

interface TaskMember {
  userId: string;
  fullName: string;
  email: string;
  role: TaskMemberRole;
}

interface PendingInvite {
  id: string;
  inviteeEmail: string;
  role: TaskMemberRole;
  status: "PENDING" | "EXPIRED";
}

async function fetchMembers(projectId: string, taskId: string): Promise<TaskMember[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/members`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load task collaborators");
  return res.json();
}

async function fetchPendingInvites(projectId: string, taskId: string): Promise<PendingInvite[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/invitations?status=PENDING`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to load invitations");
  return res.json();
}

export default function TaskCollaboratorsModal({
  projectId,
  taskId,
  open,
  onOpenChange,
}: {
  projectId: string;
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TaskMemberRole>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const membersQuery = useQuery({
    queryKey: ["task-members", taskId],
    queryFn: () => fetchMembers(projectId, taskId),
    enabled: open,
  });
  const invitesQuery = useQuery({
    queryKey: ["task-invitations", taskId],
    queryFn: () => fetchPendingInvites(projectId, taskId),
    enabled: open,
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetEmail: email, role }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to send invite");
      return res.json();
    },
    onSuccess: () => {
      setEmail("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["task-invitations", taskId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/invitations/${inviteId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to revoke invite");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-invitations", taskId] }),
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}/members/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to remove collaborator");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-members", taskId] }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this task</DialogTitle>
          <DialogDescription>
            Grants access to this one task only — not the rest of the engagement's backlog.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            inviteMutation.mutate();
          }}
        >
          <Input
            type="email"
            required
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <Select value={role} onValueChange={(v) => setRole(v as TaskMemberRole)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="VIEWER">Viewer</SelectItem>
              <SelectItem value="EDITOR">Editor</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={inviteMutation.isPending}>
            {inviteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          </Button>
        </form>
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="space-y-1">
          <h4 className="text-sm font-medium text-muted-foreground">Shared with</h4>
          {(membersQuery.data ?? []).length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">Not shared with anyone yet.</p>
          )}
          {membersQuery.data?.map((m) => (
            <div key={m.userId} className="flex items-center gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              <Badge variant="secondary">{m.role.toLowerCase()}</Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => removeMutation.mutate(m.userId)}
                title="Remove"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {(invitesQuery.data?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <h4 className="text-sm font-medium text-muted-foreground">Pending invitations</h4>
            {invitesQuery.data!.map((inv) => (
              <div key={inv.id} className="flex items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{inv.inviteeEmail}</p>
                </div>
                <Badge variant="outline">{inv.role.toLowerCase()}</Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => revokeMutation.mutate(inv.id)}
                  title="Revoke invitation"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
