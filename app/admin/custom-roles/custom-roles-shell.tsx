"use client";

/**
 * Superadmin-only custom role manager. A custom role is just a name + scope
 * (PROJECT or CLIENT) — its actual permission grants are edited on the
 * Permissions matrix page (a custom role shows up there as an extra column
 * once it exists here). Deleting a role here also clears its matrix
 * tickboxes and any client/engagement grants that used it (see
 * services/custom-roles.ts's deleteCustomRole).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type RoleScope = "PROJECT" | "CLIENT";

interface CustomRole {
  id: string;
  name: string;
  scope: RoleScope;
  description: string | null;
}

async function fetchRoles(): Promise<CustomRole[]> {
  const res = await fetch("/api/admin/custom-roles", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load custom roles");
  return res.json();
}

export default function CustomRolesShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<RoleScope>("PROJECT");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ["admin-custom-roles"],
    queryFn: fetchRoles,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-custom-roles"] });

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Role name is required.");
      const body = editing
        ? { name: name.trim(), description: description || null }
        : { name: name.trim(), scope, description: description || undefined };
      const url = editing ? `/api/admin/custom-roles/${editing.id}` : "/api/admin/custom-roles";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save role");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setEditorOpen(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: async (roleId: string) => {
      const res = await fetch(`/api/admin/custom-roles/${roleId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to delete role");
    },
    onSuccess: invalidate,
  });

  function openCreate() {
    setEditing(null);
    setName("");
    setScope("PROJECT");
    setDescription("");
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(r: CustomRole) {
    setEditing(r);
    setName(r.name);
    setScope(r.scope);
    setDescription(r.description ?? "");
    setError(null);
    setEditorOpen(true);
  }

  const projectRoles = roles.filter((r) => r.scope === "PROJECT");
  const clientRoles = roles.filter((r) => r.scope === "CLIENT");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b-2 border-b-gold px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to dashboard
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-gold" />
          Super admin
        </span>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Custom roles</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Name a role, choose whether it applies to one engagement (PROJECT) or every engagement
              under a client at once (CLIENT), then set its grants on the{" "}
              <a href="/admin/permissions" className="underline">
                permissions matrix
              </a>
              . Assign it to people from a client's or engagement's collaborators panel.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            New custom role
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : roles.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No custom roles yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <RoleGroup title="Engagement-scoped (PROJECT)" roles={projectRoles} onEdit={openEdit} onDelete={(id) => remove.mutate(id)} deleting={remove.isPending} />
            <RoleGroup title="Client-wide (CLIENT)" roles={clientRoles} onEdit={openEdit} onDelete={(id) => remove.mutate(id)} deleting={remove.isPending} />
          </div>
        )}
      </main>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit custom role" : "New custom role"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Scope can't be changed after creation — delete and recreate if you need a different one."
                : "PROJECT roles are granted on one engagement at a time; CLIENT roles apply to every engagement under a client at once."}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              save.mutate();
            }}
          >
            <Input placeholder="Role name" value={name} onChange={(e) => setName(e.target.value)} required />
            {!editing && (
              <Select value={scope} onValueChange={(v) => setScope(v as RoleScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PROJECT">PROJECT — one engagement at a time</SelectItem>
                  <SelectItem value="CLIENT">CLIENT — every engagement under a client</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={save.isPending}>
              {save.isPending ? "Saving…" : editing ? "Save changes" : "Create role"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoleGroup({
  title,
  roles,
  onEdit,
  onDelete,
  deleting,
}: {
  title: string;
  roles: CustomRole[];
  onEdit: (r: CustomRole) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  if (roles.length === 0) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="space-y-2">
        {roles.map((r) => (
          <Card key={r.id}>
            <CardContent className="flex items-start justify-between gap-3 p-4">
              <div>
                <h3 className="font-medium">{r.name}</h3>
                {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => onEdit(r)}>
                  Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => onDelete(r.id)} disabled={deleting}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
