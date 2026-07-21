"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, UserPlus, MoreHorizontal, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

type ProjectRole = "PROJECT_ADMIN" | "EDITOR" | "VIEWER";

interface Member {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl?: string | null;
  role: ProjectRole;
}

interface PendingInvite {
  id: string;
  inviteeEmail: string;
  role: ProjectRole;
  status: "PENDING" | "EXPIRED";
}

async function fetchMembers(projectId: string): Promise<Member[]> {
  const res = await fetch(`/api/projects/${projectId}/members`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

async function fetchPendingInvites(projectId: string): Promise<PendingInvite[]> {
  const res = await fetch(`/api/projects/${projectId}/invitations?status=PENDING`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to load invitations");
  return res.json();
}

async function sendInvite(projectId: string, targetEmail: string, role: ProjectRole) {
  const res = await fetch(`/api/projects/${projectId}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetEmail, role }),
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to send invite");
  return res.json();
}

async function revokeInvite(projectId: string, inviteId: string) {
  const res = await fetch(`/api/projects/${projectId}/invitations/${inviteId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to revoke invite");
}

async function updateMemberRole(projectId: string, userId: string, role: ProjectRole) {
  const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update role");
}

async function removeMember(projectId: string, userId: string) {
  const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to remove member");
}

export default function ProjectCollaboratorModal({
  projectId,
  open,
  onOpenChange,
  currentUserRole,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserRole: ProjectRole;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const canManage = currentUserRole === "PROJECT_ADMIN";

  const membersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => fetchMembers(projectId),
    enabled: open,
  });

  const invitesQuery = useQuery({
    queryKey: ["project-invitations", projectId],
    queryFn: () => fetchPendingInvites(projectId),
    enabled: open && canManage,
  });

  const inviteMutation = useMutation({
    mutationFn: () => sendInvite(projectId, email, role),
    onSuccess: () => {
      setEmail("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["project-invitations", projectId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(projectId, inviteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-invitations", projectId] }),
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, newRole }: { userId: string; newRole: ProjectRole }) =>
      updateMemberRole(projectId, userId, newRole),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(projectId, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Project collaborators</DialogTitle>
          <DialogDescription>
            Invite people to this project without giving them access to the rest of the workspace.
          </DialogDescription>
        </DialogHeader>

        {canManage && (
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
            <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VIEWER">Viewer</SelectItem>
                <SelectItem value="EDITOR">Editor</SelectItem>
                <SelectItem value="PROJECT_ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
            </Button>
          </form>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="space-y-1">
          <h4 className="text-sm font-medium text-muted-foreground">Members</h4>
          {membersQuery.data?.map((m) => (
            <div key={m.userId} className="flex items-center gap-2 py-1.5">
              <Avatar className="h-7 w-7">
                <AvatarImage src={m.avatarUrl ?? undefined} />
                <AvatarFallback>{m.fullName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium">{m.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              {canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {(["PROJECT_ADMIN", "EDITOR", "VIEWER"] as ProjectRole[]).map((r) => (
                      <DropdownMenuItem
                        key={r}
                        disabled={r === m.role}
                        onSelect={() => roleMutation.mutate({ userId: m.userId, newRole: r })}
                      >
                        Make {r.replace("_", " ").toLowerCase()}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => removeMutation.mutate(m.userId)}
                    >
                      Remove from project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Badge variant="secondary">{m.role.replace("_", " ").toLowerCase()}</Badge>
              )}
            </div>
          ))}
        </div>

        {canManage && (invitesQuery.data?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <h4 className="text-sm font-medium text-muted-foreground">Pending invitations</h4>
            {invitesQuery.data!.map((inv) => (
              <div key={inv.id} className="flex items-center gap-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm">{inv.inviteeEmail}</p>
                </div>
                <Badge variant="outline">{inv.role.replace("_", " ").toLowerCase()}</Badge>
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
