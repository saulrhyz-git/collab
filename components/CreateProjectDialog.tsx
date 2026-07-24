"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Project {
  id: string;
  name: string;
}

interface ClientSummary {
  id: string;
  name: string;
}

interface EngagementTypeSummary {
  id: string;
  name: string;
}

const NO_CLIENT = "__none__";
const NEW_CLIENT = "__new__";
const NO_ENGAGEMENT_TYPE = "__none__";

async function fetchClients(workspaceId: string): Promise<ClientSummary[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/clients`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load clients");
  return res.json();
}

async function fetchEngagementTypes(): Promise<EngagementTypeSummary[]> {
  const res = await fetch("/api/admin/engagement-types", { credentials: "include" });
  if (!res.ok) return []; // non-fatal — the picker just won't offer any
  return res.json();
}

async function applyEngagementTypeToProject(projectId: string, engagementTypeId: string) {
  const res = await fetch(`/api/projects/${projectId}/apply-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ engagementTypeId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to populate backlog");
}

async function createClient(workspaceId: string, name: string): Promise<ClientSummary> {
  const res = await fetch(`/api/workspaces/${workspaceId}/clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to add client");
  return res.json();
}

async function createProject(
  workspaceId: string,
  body: {
    name: string;
    description?: string;
    visibility: "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS";
    clientId?: string | null;
  }
): Promise<Project> {
  const res = await fetch(`/api/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create project");
  return res.json();
}

export default function CreateProjectDialog({
  workspaceId,
  open,
  onOpenChange,
  defaultClientId,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects a client — used when creating an engagement from that client's own detail page. */
  defaultClientId?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // "Visible to everyone in this workspace" was removed from this picker —
  // under the current access model (see db/rls-policies.sql's PART 2),
  // workspace membership alone no longer grants visibility into an
  // engagement, so PUBLIC_TO_WORKSPACE is a no-op. Every engagement is
  // effectively PRIVATE_TO_MEMBERS now: access comes from being invited to
  // it (or its client, or a specific task), being the workspace owner/admin,
  // or being a super admin.
  const visibility: "PRIVATE_TO_MEMBERS" = "PRIVATE_TO_MEMBERS";
  const [clientSelection, setClientSelection] = useState<string>(defaultClientId ?? NO_CLIENT);
  const [newClientName, setNewClientName] = useState("");
  const [engagementTypeId, setEngagementTypeId] = useState<string>(NO_ENGAGEMENT_TYPE);
  const [error, setError] = useState<string | null>(null);

  const { data: clientOptions = [] } = useQuery({
    queryKey: ["clients", workspaceId],
    queryFn: () => fetchClients(workspaceId),
    enabled: open,
  });

  const { data: engagementTypeOptions = [] } = useQuery({
    queryKey: ["engagement-types"],
    queryFn: fetchEngagementTypes,
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      let clientId: string | null = null;
      if (clientSelection === NEW_CLIENT) {
        const trimmed = newClientName.trim();
        if (!trimmed) throw new Error("Enter a name for the new client.");
        const created = await createClient(workspaceId, trimmed);
        queryClient.invalidateQueries({ queryKey: ["clients", workspaceId] });
        clientId = created.id;
      } else if (clientSelection !== NO_CLIENT) {
        clientId = clientSelection;
      }
      const project = await createProject(workspaceId, {
        name,
        description: description || undefined,
        visibility,
        clientId,
      });

      // Populate the backlog from the selected engagement type's linked
      // templates. Best-effort: the project itself is already created by
      // this point, so a failure here surfaces as an error but doesn't
      // undo project creation — the user can apply a template manually
      // from the engagement page instead.
      if (engagementTypeId !== NO_ENGAGEMENT_TYPE) {
        await applyEngagementTypeToProject(project.id, engagementTypeId);
      }

      return project;
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", workspaceId] });
      onOpenChange(false);
      setName("");
      setDescription("");
      setClientSelection(defaultClientId ?? NO_CLIENT);
      setNewClientName("");
      setEngagementTypeId(NO_ENGAGEMENT_TYPE);
      router.push(`/projects/${project.id}`);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Attach it to a client to track it as an engagement, or leave it unattached for internal
            work. You can invite people to just this project later without giving them access to the
            rest of the workspace.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          <Input
            placeholder="Project / engagement name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Client</label>
            <Select value={clientSelection} onValueChange={setClientSelection}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CLIENT}>No client — internal project</SelectItem>
                {clientOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CLIENT}>+ New client…</SelectItem>
              </SelectContent>
            </Select>
            {clientSelection === NEW_CLIENT && (
              <Input
                autoFocus
                placeholder="Client name"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
              />
            )}
          </div>

          {engagementTypeOptions.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Engagement type</label>
              <Select value={engagementTypeId} onValueChange={setEngagementTypeId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ENGAGEMENT_TYPE}>None — start with an empty backlog</SelectItem>
                  {engagementTypeOptions.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Populates the backlog from that type's linked task templates.
              </p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Only you, a workspace admin, or people you invite to this engagement (or its client)
            will have access — collaborators are always added explicitly, never by default.
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create project"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
