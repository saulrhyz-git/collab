"use client";

/**
 * Superadmin-only engagement type builder — maps a named "kind of matter"
 * (e.g. "Employment Contract Review") to one or more task templates. When
 * someone creates (or later updates) an engagement of this type, every
 * linked template's tasks get applied to the backlog in one shot — see
 * services/apply-template.ts's applyEngagementType.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Briefcase, Plus, Trash2 } from "lucide-react";
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

interface TaskTemplateSummary {
  id: string;
  name: string;
}

interface EngagementType {
  id: string;
  name: string;
  description: string | null;
  templates: { templateId: string; template: TaskTemplateSummary }[];
}

async function fetchEngagementTypes(): Promise<EngagementType[]> {
  const res = await fetch("/api/admin/engagement-types", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load engagement types");
  return res.json();
}

async function fetchTemplateOptions(): Promise<TaskTemplateSummary[]> {
  const res = await fetch("/api/admin/task-templates", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load task templates");
  return res.json();
}

export default function EngagementTypesShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<EngagementType | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateIds, setTemplateIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { data: types = [], isLoading } = useQuery({
    queryKey: ["admin-engagement-types"],
    queryFn: fetchEngagementTypes,
  });

  const { data: templateOptions = [] } = useQuery({
    queryKey: ["admin-task-templates-options"],
    queryFn: fetchTemplateOptions,
    enabled: editorOpen,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-engagement-types"] });

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Engagement type name is required.");
      const body = {
        name: name.trim(),
        description: description || undefined,
        templateIds: Array.from(templateIds),
      };
      const url = editing ? `/api/admin/engagement-types/${editing.id}` : "/api/admin/engagement-types";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save engagement type");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setEditorOpen(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/engagement-types/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to delete engagement type");
    },
    onSuccess: invalidate,
  });

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setTemplateIds(new Set());
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(t: EngagementType) {
    setEditing(t);
    setName(t.name);
    setDescription(t.description ?? "");
    setTemplateIds(new Set(t.templates.map((link) => link.templateId)));
    setError(null);
    setEditorOpen(true);
  }

  function toggleTemplate(id: string) {
    const next = new Set(templateIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTemplateIds(next);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b-2 border-b-gold px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to dashboard
        </Button>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Engagement types</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick which task templates apply automatically when a new engagement of this type is
              created.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            New engagement type
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : types.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No engagement types yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {types.map((t) => (
              <Card key={t.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-1.5 font-medium">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        {t.name}
                      </h3>
                      {t.description && <p className="text-sm text-muted-foreground">{t.description}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.templates.length === 0
                          ? "No templates linked"
                          : t.templates.map((link) => link.template.name).join(", ")}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(t)}>
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => remove.mutate(t.id)}
                        disabled={remove.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit engagement type" : "New engagement type"}</DialogTitle>
            <DialogDescription>
              Every linked template's tasks apply together when this type is selected.
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
            <Input placeholder="Engagement type name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Linked task templates</label>
              {templateOptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No task templates exist yet — create one first.
                </p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                  {templateOptions.map((opt) => (
                    <label key={opt.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-gold"
                        checked={templateIds.has(opt.id)}
                        onChange={() => toggleTemplate(opt.id)}
                      />
                      {opt.name}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={save.isPending}>
              {save.isPending ? "Saving…" : editing ? "Save changes" : "Create engagement type"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
