"use client";

/**
 * AI Review tab — upload a contract/MOA/other legal document, run it
 * through whichever AI provider is configured (see /admin/ai-provider-settings),
 * and get back a plain-language summary, recommendations, and notable
 * clauses. "Add to References" flips the file over to the References tab
 * once it's been reviewed (services/project-files.ts's promoteFileToReferences).
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, Lightbulb, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/utils";

interface AiReviewResult {
  summary: string;
  recommendations: string[];
  notables: string[];
  provider: "openai" | "gemini";
  model: string;
}

interface ProjectFile {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  aiReviewSummary: string | null;
  uploader: { id: string; fullName: string; avatarUrl: string | null } | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseStoredReview(raw: string | null): AiReviewResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.summary === "string" && Array.isArray(parsed.recommendations) && Array.isArray(parsed.notables)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFiles(projectId: string): Promise<ProjectFile[]> {
  const res = await fetch(`/api/projects/${projectId}/files?category=AI_REVIEWED`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load files");
  return res.json();
}

export default function AiReviewTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const { data: files = [], isLoading } = useQuery({
    queryKey: ["project-files", projectId, "AI_REVIEWED"],
    queryFn: () => fetchFiles(projectId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["project-files", projectId, "AI_REVIEWED"] });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("category", "AI_REVIEWED");
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

  const review = useMutation({
    mutationFn: async (fileId: string) => {
      setReviewingId(fileId);
      const res = await fetch(`/api/projects/${projectId}/files/${fileId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "AI review failed");
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => setReviewingId(null),
  });

  const promote = useMutation({
    mutationFn: async (fileId: string) => {
      const res = await fetch(`/api/projects/${projectId}/files/${fileId}/promote`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to add to References");
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["project-files", projectId, "REFERENCE"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Upload a contract, MOA, or other legal document and run it through AI for a summary,
          recommendations, and notable clauses. Not legal advice.
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
            {upload.isPending ? "Uploading…" : "Upload document"}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : files.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No documents uploaded for review yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {files.map((f) => {
            const parsedReview = parseStoredReview(f.aiReviewSummary);
            const isReviewing = reviewingId === f.id && review.isPending;
            return (
              <Card key={f.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
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
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant={parsedReview ? "outline" : "default"}
                        onClick={() => review.mutate(f.id)}
                        disabled={isReviewing}
                      >
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        {isReviewing ? "Reviewing…" : parsedReview ? "Re-review" : "Review via AI"}
                      </Button>
                      {parsedReview && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => promote.mutate(f.id)}
                          disabled={promote.isPending}
                        >
                          Add to References
                        </Button>
                      )}
                    </div>
                  </div>

                  {parsedReview && (
                    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
                      <p className="text-foreground/90">{parsedReview.summary}</p>

                      {parsedReview.recommendations.length > 0 && (
                        <div>
                          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                            <Lightbulb className="h-3.5 w-3.5" />
                            Recommendations
                          </p>
                          <ul className="list-inside list-disc space-y-0.5 text-sm">
                            {parsedReview.recommendations.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {parsedReview.notables.length > 0 && (
                        <div>
                          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Notables
                          </p>
                          <ul className="list-inside list-disc space-y-0.5 text-sm">
                            {parsedReview.notables.map((n, i) => (
                              <li key={i}>{n}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3 w-3" />
                        Reviewed via {parsedReview.provider === "openai" ? "OpenAI" : "Gemini"} ({parsedReview.model})
                        — not legal advice.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
