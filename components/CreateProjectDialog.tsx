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

const NO_CLIENT = "__none__";
const NEW_CLIENT = "__new__";

async function fetchClients(workspaceId: string): Promise<ClientSummary[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/clients`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load clients");
  return res.json();
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
  const [visibility, setVisibility] = useState<"PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS">(
    "PRIVATE_TO_MEMBERS"
  );
  const [clientSelection, setClientSelection] = useState<string>(defaultClientId ?? NO_CLIENT);
  const [newClientName, setNewClientName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: clientOptions = [] } = useQuery({
    queryKey: ["clients", workspaceId],
    queryFn: () => fetchClients(workspaceId),
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
      return createProject(workspaceId, {
        name,
        description: description || undefined,
        visibility,
        clientId,
      });
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", workspaceId] });
      onOpenChange(false);
      setName("");
      setDescription("");
      setClientSelection(defaultClientId ?? NO_CLIENT);
      setNewClientName("");
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

          <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PRIVATE_TO_MEMBERS">Private — only invited members</SelectItem>
              <SelectItem value="PUBLIC_TO_WORKSPACE">Visible to everyone in this workspace</SelectItem>
            </SelectContent>
          </Select>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create project"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
