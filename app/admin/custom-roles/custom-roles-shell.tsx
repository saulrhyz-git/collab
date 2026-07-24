"use client";

/**
 * Superadmin-only custom role manager. A custom role is a name + scope
 * (PROJECT or CLIENT) *plus* its aspect x action grants — both are set
 * together in one dialog now, rather than creating the role here and then
 * hopping to a separate permissions-matrix page to grant it anything.
 * PROJECT and CLIENT roles share the exact same permission-key vocabulary
 * (view/create/edit/delete per aspect: Tasks, Comments, Files,
 * Collaborators, Engagement, AI Review) — a CLIENT role's grants just apply
 * across every engagement under a client at once instead of one at a time.
 * A person can hold several roles simultaneously on the same client or
 * engagement; their effective permissions are the union (OR) of everything
 * every held role grants — see services/permissions.ts's
 * userCanPerformOnProject.
 */

import { useEffect, useState } from "react";
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
import { cn } from "@/lib/utils";

type RoleScope = "PROJECT" | "CLIENT";

interface CustomRole {
  id: string;
  name: string;
  scope: RoleScope;
  description: string | null;
}

interface CustomRoleWithGrants extends CustomRole {
  grantedKeys: string[];
}

interface CatalogAction {
  key: string;
  action: string;
  label: string;
  description: string | null;
}

interface CatalogAspect {
  aspect: string;
  label: string;
  actions: CatalogAction[];
}

const ACTION_COLUMNS: { action: string; label: string }[] = [
  { action: "view", label: "View" },
  { action: "create", label: "Create" },
  { action: "edit", label: "Edit" },
  { action: "delete", label: "Delete" },
];

async function fetchRoles(): Promise<CustomRole[]> {
  const res = await fetch("/api/admin/custom-roles", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load custom roles");
  return res.json();
}

async function fetchCatalog(): Promise<CatalogAspect[]> {
  const res = await fetch("/api/admin/permission-catalog", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load the permission catalog");
  return res.json();
}

async function fetchRoleWithGrants(roleId: string): Promise<CustomRoleWithGrants> {
  const res = await fetch(`/api/admin/custom-roles/${roleId}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load this role's permissions");
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
  const [grantedKeys, setGrantedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ["admin-custom-roles"],
    queryFn: fetchRoles,
  });

  const { data: catalog = [], isLoading: catalogLoading } = useQuery({
    queryKey: ["admin-permission-catalog"],
    queryFn: fetchCatalog,
    enabled: editorOpen,
  });

  // Only fetched when editing an existing role — a brand-new role starts
  // with every box unchecked, no fetch needed. react-query v5 dropped
  // useQuery's onSuccess callback, so the fetched grants are synced into
  // local state via this effect instead.
  const { data: roleWithGrants, isFetching: grantsLoading } = useQuery({
    queryKey: ["admin-custom-role-grants", editing?.id],
    queryFn: () => fetchRoleWithGrants(editing!.id),
    enabled: editorOpen && !!editing,
  });

  useEffect(() => {
    if (roleWithGrants) setGrantedKeys(new Set(roleWithGrants.grantedKeys));
  }, [roleWithGrants]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-custom-roles"] });
    queryClient.invalidateQueries({ queryKey: ["admin-permissions"] }); // matrix page's cache, if open elsewhere
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Role name is required.");
      const body = editing
        ? { name: name.trim(), description: description || null, grantedKeys: Array.from(grantedKeys) }
        : { name: name.trim(), scope, description: description || undefined, grantedKeys: Array.from(grantedKeys) };
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
    setGrantedKeys(new Set());
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(r: CustomRole) {
    setEditing(r);
    setName(r.name);
    setScope(r.scope);
    setDescription(r.description ?? "");
    setGrantedKeys(new Set()); // populated once fetchRoleWithGrants resolves
    setError(null);
    setEditorOpen(true);
  }

  function toggleKey(key: string, checked: boolean) {
    setGrantedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
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
              under a client at once (CLIENT), and tick its View/Create/Edit/Delete grants per aspect —
              all in one step. Assign it to people from a client's or engagement's collaborators panel;
              someone can hold several roles at once and gets the union of everything they grant.
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
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit custom role" : "New custom role"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Scope can't be changed after creation — delete and recreate if you need a different one. Grants below fully replace this role's permissions on save."
                : "PROJECT roles are granted on one engagement at a time; CLIENT roles apply to every engagement under a client at once. Both use the same grant checkboxes below."}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              save.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Input placeholder="Role name" value={name} onChange={(e) => setName(e.target.value)} required />
              {!editing ? (
                <Select value={scope} onValueChange={(v) => setScope(v as RoleScope)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROJECT">PROJECT — one engagement at a time</SelectItem>
                    <SelectItem value="CLIENT">CLIENT — every engagement under a client</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex items-center rounded-md border px-3 text-sm text-muted-foreground">
                  {scope === "PROJECT" ? "PROJECT — one engagement at a time" : "CLIENT — every engagement under a client"}
                </div>
              )}
            </div>
            <Textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />

            <div>
              <h3 className="mb-2 text-sm font-semibold">Permissions</h3>
              {catalogLoading || (editing && grantsLoading) ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Loading permissions…</p>
              ) : (
                <PermissionGrid catalog={catalog} grantedKeys={grantedKeys} onToggle={toggleKey} />
              )}
            </div>

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

function PermissionGrid({
  catalog,
  grantedKeys,
  onToggle,
}: {
  catalog: CatalogAspect[];
  grantedKeys: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  if (catalog.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No permissions defined.</p>;
  }

  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-b-gold bg-muted/40">
              <th className="w-40 px-4 py-2 text-left font-semibold">Aspect</th>
              {ACTION_COLUMNS.map((col) => (
                <th key={col.action} className="px-3 py-2 text-center font-semibold">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.map((row) => {
              const actionsByType = new Map(row.actions.map((a) => [a.action, a]));
              return (
                <tr key={row.aspect} className="border-b last:border-b-0 hover:bg-accent/30">
                  <td className="px-4 py-2.5 font-medium">{row.label}</td>
                  {ACTION_COLUMNS.map((col) => {
                    const action = actionsByType.get(col.action);
                    if (!action) {
                      // No corresponding capability for this aspect (e.g.
                      // comments has no "edit" — nobody can edit someone
                      // else's comment) — deliberately blank, not a
                      // disabled checkbox pretending an action exists.
                      return <td key={col.action} className="px-3 py-2.5 text-center text-muted-foreground">—</td>;
                    }
                    return (
                      <td key={col.action} className="px-3 py-2.5 text-center" title={action.description ?? undefined}>
                        <input
                          type="checkbox"
                          className={cn("h-4 w-4 cursor-pointer accent-gold")}
                          checked={grantedKeys.has(action.key)}
                          onChange={(e) => onToggle(action.key, e.target.checked)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
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
