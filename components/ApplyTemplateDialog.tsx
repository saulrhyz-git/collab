"use client";

/**
 * Lets a project member (with task-creation rights — enforced server-side
 * by services/apply-template.ts) populate this engagement's backlog from
 * an existing task template or engagement type, at any point after the
 * engagement was created (not just at creation time — see
 * CreateProjectDialog for that path).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TaskTemplateOption {
  id: string;
  name: string;
  items: { title: string }[];
}

interface EngagementTypeOption {
  id: string;
  name: string;
  templates: { template: { name: string } }[];
}

async function fetchTemplates(): Promise<TaskTemplateOption[]> {
  const res = await fetch("/api/admin/task-templates", { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

async function fetchEngagementTypes(): Promise<EngagementTypeOption[]> {
  const res = await fetch("/api/admin/engagement-types", { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

export default function ApplyTemplateDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: templates = [] } = useQuery({
    queryKey: ["admin-task-templates-options"],
    queryFn: fetchTemplates,
    enabled: open,
  });
  const { data: engagementTypes = [] } = useQuery({
    queryKey: ["admin-engagement-types-options"],
    queryFn: fetchEngagementTypes,
    enabled: open,
  });

  const apply = useMutation({
    mutationFn: async (body: { templateId: string } | { engagementTypeId: string }) => {
      const res = await fetch(`/api/projects/${projectId}/apply-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to apply template");
      return res.json() as Promise<{ tasksCreated: number }>;
    },
    onSuccess: (result) => {
      setError(null);
      setSuccess(`Added ${result.tasksCreated} task${result.tasksCreated === 1 ? "" : "s"} to the backlog.`);
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-tasks", projectId] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Apply a template</DialogTitle>
          <DialogDescription>
            Adds tasks to this engagement's backlog. Existing tasks aren't touched or removed.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="templates">
          <TabsList>
            <TabsTrigger value="templates">Task templates</TabsTrigger>
            <TabsTrigger value="types">Engagement types</TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="space-y-2">
            {templates.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No task templates yet.</p>
            ) : (
              templates.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                      {t.name}
                    </p>
                    <p className="text-xs text-muted-foreground">{t.items.length} tasks</p>
                  </div>
                  <Button
                    size="sm"
                    disabled={apply.isPending}
                    onClick={() => apply.mutate({ templateId: t.id })}
                  >
                    Apply
                  </Button>
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="types" className="space-y-2">
            {engagementTypes.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No engagement types yet.</p>
            ) : (
              engagementTypes.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                      {t.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.templates.length === 0
                        ? "No templates linked"
                        : t.templates.map((link) => link.template.name).join(", ")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={apply.isPending}
                    onClick={() => apply.mutate({ engagementTypeId: t.id })}
                  >
                    Apply
                  </Button>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-emerald-600">{success}</p>}
      </DialogContent>
    </Dialog>
  );
}
