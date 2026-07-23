"use client";

/**
 * Superadmin-only task template builder: create/edit a named list of tasks
 * (title + optional description + priority) that later gets applied in
 * bulk to a project's backlog, either directly or via an engagement type
 * (see /admin/engagement-types and the "Apply template" flow on a project).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ListChecks, Plus, Trash2, X } from "lucide-react";
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

type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface TemplateItem {
  title: string;
  description?: string | null;
  priority: Priority;
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  items: TemplateItem[];
}

interface DraftItem {
  title: string;
  description: string;
  priority: Priority;
}

async function fetchTemplates(): Promise<Template[]> {
  const res = await fetch("/api/admin/task-templates", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load task templates");
  return res.json();
}

function emptyItem(): DraftItem {
  return { title: "", description: "", priority: "MEDIUM" };
}

export default function TaskTemplatesShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [error, setError] = useState<string | null>(null);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["admin-task-templates"],
    queryFn: fetchTemplates,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-task-templates"] });

  const save = useMutation({
    mutationFn: async () => {
      const trimmedItems = items
        .map((i) => ({ ...i, title: i.title.trim() }))
        .filter((i) => i.title.length > 0);
      if (!name.trim()) throw new Error("Template name is required.");
      if (trimmedItems.length === 0) throw new Error("Add at least one task.");

      const body = {
        name: name.trim(),
        description: description || undefined,
        items: trimmedItems.map((i) => ({
          title: i.title,
          description: i.description || undefined,
          priority: i.priority,
        })),
      };

      const url = editing ? `/api/admin/task-templates/${editing.id}` : "/api/admin/task-templates";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save template");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setEditorOpen(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await fetch(`/api/admin/task-templates/${templateId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to delete template");
    },
    onSuccess: invalidate,
  });

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setItems([emptyItem()]);
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(t: Template) {
    setEditing(t);
    setName(t.name);
    setDescription(t.description ?? "");
    setItems(
      t.items.length > 0
        ? t.items.map((i) => ({ title: i.title, description: i.description ?? "", priority: i.priority }))
        : [emptyItem()]
    );
    setError(null);
    setEditorOpen(true);
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
            <h1 className="text-2xl font-semibold">Task templates</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Reusable lists of backlog tasks. Link one to an engagement type so it applies
              automatically when someone builds an engagement of that type.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            New template
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No task templates yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {templates.map((t) => (
              <Card key={t.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-1.5 font-medium">
                        <ListChecks className="h-4 w-4 text-muted-foreground" />
                        {t.name}
                      </h3>
                      {t.description && <p className="text-sm text-muted-foreground">{t.description}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.items.length} task{t.items.length === 1 ? "" : "s"}
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
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit template" : "New task template"}</DialogTitle>
            <DialogDescription>
              Every task lands in BACKLOG in this order when the template is applied.
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
            <Input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Tasks</label>
              {items.map((item, index) => (
                <div key={index} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      className="flex-1"
                      placeholder={`Task ${index + 1} title`}
                      value={item.title}
                      onChange={(e) => {
                        const next = [...items];
                        next[index] = { ...next[index], title: e.target.value };
                        setItems(next);
                      }}
                    />
                    <Select
                      value={item.priority}
                      onValueChange={(v) => {
                        const next = [...items];
                        next[index] = { ...next[index], priority: v as Priority };
                        setItems(next);
                      }}
                    >
                      <SelectTrigger className="w-28 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="LOW">Low</SelectItem>
                        <SelectItem value="MEDIUM">Medium</SelectItem>
                        <SelectItem value="HIGH">High</SelectItem>
                        <SelectItem value="URGENT">Urgent</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => setItems(items.filter((_, i) => i !== index))}
                      disabled={items.length === 1}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <Textarea
                    placeholder="Task description (optional)"
                    rows={2}
                    value={item.description}
                    onChange={(e) => {
                      const next = [...items];
                      next[index] = { ...next[index], description: e.target.value };
                      setItems(next);
                    }}
                  />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setItems([...items, emptyItem()])}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add task
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={save.isPending}>
              {save.isPending ? "Saving…" : editing ? "Save changes" : "Create template"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
