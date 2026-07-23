"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

async function createProject(
  workspaceId: string,
  body: { name: string; description?: string; visibility: "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS" }
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
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS">(
    "PRIVATE_TO_MEMBERS"
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createProject(workspaceId, { name, description: description || undefined, visibility }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] });
      onOpenChange(false);
      setName("");
      setDescription("");
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
            Projects live inside this workspace — you can invite people to just this project later
            without giving them access to the rest of the workspace.
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
            placeholder="Project name"
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
