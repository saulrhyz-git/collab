"use client";

/**
 * Client-wide collaborators — a grant here applies across every engagement
 * under this client at once (CLIENT-scoped custom role), distinct from
 * inviting someone to one engagement (ProjectCollaboratorModal) or one task
 * (TaskCollaboratorsModal). Mirrors ProjectCollaboratorModal's shape;
 * authorization is enforced server-side (services/client-members.ts,
 * services/client-invitations.ts) — a user without client.manage or
 * creator/admin standing will see the invite/remove calls fail with a
 * clear inline error rather than the UI trying to pre-compute permissions.
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

interface CustomRole {
  id: string;
  name: string;
  scope: "PROJECT" | "CLIENT";
}

interface ClientMember {
  userId: string;
  fullName: string;
  email: string;
  customRoleId: string;
  customRoleName: string;
}

interface PendingInvite {
  id: string;
  inviteeEmail: string;
  customRoleId: string;
  status: "PENDING" | "EXPIRED";
}

async function fetchClientRoles(): Promise<CustomRole[]> {
  const res = await fetch("/api/admin/custom-roles?scope=CLIENT", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load custom roles");
  return res.json();
}

async function fetchMembers(clientId: string): Promise<ClientMember[]> {
  const res = await fetch(`/api/clients/${clientId}/members`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load collaborators");
  return res.json();
}

async function fetchPendingInvites(clientId: string): Promise<PendingInvite[]> {
  const res = await fetch(`/api/clients/${clientId}/invitations?status=PENDING`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load invitations");
  return res.json();
}

export default function ClientCollaboratorsModal({
  clientId,
  open,
  onOpenChange,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [customRoleId, setCustomRoleId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const rolesQuery = useQuery({ queryKey: ["custom-roles", "CLIENT"], queryFn: fetchClientRoles, enabled: open });
  const membersQuery = useQuery({
    queryKey: ["client-members", clientId],
    queryFn: () => fetchMembers(clientId),
    enabled: open,
  });
  const invitesQuery = useQuery({
    queryKey: ["client-invitations", clientId],
    queryFn: () => fetchPendingInvites(clientId),
    enabled: open,
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetEmail: email, customRoleId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to send invite");
      return res.json();
    },
    onSuccess: () => {
      setEmail("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["client-invitations", clientId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      const res = await fetch(`/api/clients/${clientId}/invitations/${inviteId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to revoke invite");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client-invitations", clientId] }),
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(`/api/clients/${clientId}/members/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to remove collaborator");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client-members", clientId] }),
  });

  const roles = rolesQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Client collaborators</DialogTitle>
          <DialogDescription>
            Access here applies across every engagement under this client at once. For one
            engagement only, use that engagement's own collaborators panel instead.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!customRoleId) {
              setError("Choose a custom role first.");
              return;
            }
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
          <Select value={customRoleId} onValueChange={setCustomRoleId}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={roles.length === 0 ? "No roles yet" : "Role"} />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={inviteMutation.isPending || roles.length === 0}>
            {inviteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          </Button>
        </form>
        {roles.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No CLIENT-scoped custom roles exist yet — a super admin can create one under Admin →
            Custom roles.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="space-y-1">
          <h4 className="text-sm font-medium text-muted-foreground">Collaborators</h4>
          {(membersQuery.data ?? []).length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">No collaborators yet.</p>
          )}
          {membersQuery.data?.map((m) => (
            <div key={m.userId} className="flex items-center gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              <Badge variant="secondary">{m.customRoleName}</Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => removeMutation.mutate(m.userId)}
                title="Remove collaborator"
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
