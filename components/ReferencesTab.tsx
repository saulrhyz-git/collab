"use client";

/**
 * References tab — the shared library of files for this engagement.
 * Includes both directly-uploaded reference material and anything
 * promoted here from the AI Review tab (see AiReviewTab.tsx's "Add to
 * References" button) — both just show up as category REFERENCE.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/utils";

interface ProjectFile {
  id: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
  uploader: { id: string; fullName: string; avatarUrl: string | null } | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchFiles(projectId: string): Promise<ProjectFile[]> {
  const res = await fetch(`/api/projects/${projectId}/files?category=REFERENCE`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load files");
  return res.json();
}

export default function ReferencesTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: files = [], isLoading } = useQuery({
    queryKey: ["project-files", projectId, "REFERENCE"],
    queryFn: () => fetchFiles(projectId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["project-files", projectId, "REFERENCE"] });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("category", "REFERENCE");
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to upload file");
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: async (fileId: string) => {
      const res = await fetch(`/api/projects/${projectId}/files/${fileId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to delete file");
    },
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Shared reference material for this engagement — contracts, correspondence, anything worth
          keeping alongside the work.
        </p>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = "";
            }}
          />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={upload.isPending}>
            <Upload className="mr-1.5 h-4 w-4" />
            {upload.isPending ? "Uploading…" : "Upload file"}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : files.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No reference files yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <Card key={f.id}>
              <CardContent className="flex items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{f.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(f.sizeBytes)} · {f.uploader?.fullName ?? "Unknown"} ·{" "}
                      {formatRelativeTime(f.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button variant="outline" size="icon" className="h-8 w-8" asChild>
                    <a href={`/api/projects/${projectId}/files/${f.id}`} download>
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => remove.mutate(f.id)}
                    disabled={remove.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
