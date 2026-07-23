"use client";

/**
 * Superadmin-only AI provider configuration — API keys for OpenAI and
 * Gemini, plus a free-text model field per provider (not a hardcoded
 * dropdown — model lineups change often, so whatever string the admin's
 * account actually has access to works, e.g. "gpt-4o" or "gemini-1.5-pro").
 * Keys are write-only from this UI, same pattern as SMTP settings: GET
 * never returns the decrypted value.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AiProviderSettings {
  openaiModel: string;
  hasOpenaiKey: boolean;
  geminiModel: string;
  hasGeminiKey: boolean;
  defaultProvider: "openai" | "gemini";
  updatedAt: string | null;
}

async function fetchSettings(): Promise<AiProviderSettings> {
  const res = await fetch("/api/admin/ai-provider-settings", { credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to load AI provider settings");
  return res.json();
}

export default function AiProviderSettingsShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    openaiModel: "gpt-4o",
    openaiKey: "",
    geminiModel: "gemini-1.5-pro",
    geminiKey: "",
    defaultProvider: "openai" as "openai" | "gemini",
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["admin-ai-provider-settings"],
    queryFn: fetchSettings,
  });

  useEffect(() => {
    if (!settings) return;
    setForm({
      openaiModel: settings.openaiModel,
      openaiKey: "",
      geminiModel: settings.geminiModel,
      geminiKey: "",
      defaultProvider: settings.defaultProvider,
    });
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        openaiModel: form.openaiModel,
        geminiModel: form.geminiModel,
        defaultProvider: form.defaultProvider,
      };
      if (form.openaiKey !== "") body.openaiKey = form.openaiKey;
      if (form.geminiKey !== "") body.geminiKey = form.geminiKey;

      const res = await fetch("/api/admin/ai-provider-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save AI provider settings");
      return res.json() as Promise<AiProviderSettings>;
    },
    onSuccess: (updated) => {
      setError(null);
      setSuccess("AI provider settings saved.");
      setForm((f) => ({ ...f, openaiKey: "", geminiKey: "" }));
      queryClient.setQueryData(["admin-ai-provider-settings"], updated);
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b-2 border-b-gold px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to dashboard
        </Button>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 space-y-6 px-6 py-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            AI provider settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Powers the "Review via AI" action on an engagement's documents.
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Card>
            <CardContent className="space-y-5 p-4">
              <form
                className="space-y-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  save.mutate();
                }}
              >
                <div className="space-y-2 rounded-md border p-3">
                  <h3 className="text-sm font-semibold">OpenAI (ChatGPT)</h3>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Model</label>
                    <Input
                      placeholder="gpt-4o"
                      value={form.openaiModel}
                      onChange={(e) => setForm({ ...form, openaiModel: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">API key</label>
                    <Input
                      type="password"
                      placeholder={settings?.hasOpenaiKey ? "•••••••• (saved — leave blank to keep)" : "Not set"}
                      value={form.openaiKey}
                      onChange={(e) => setForm({ ...form, openaiKey: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-2 rounded-md border p-3">
                  <h3 className="text-sm font-semibold">Google Gemini</h3>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Model</label>
                    <Input
                      placeholder="gemini-1.5-pro"
                      value={form.geminiModel}
                      onChange={(e) => setForm({ ...form, geminiModel: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">API key</label>
                    <Input
                      type="password"
                      placeholder={settings?.hasGeminiKey ? "•••••••• (saved — leave blank to keep)" : "Not set"}
                      value={form.geminiKey}
                      onChange={(e) => setForm({ ...form, geminiKey: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Default provider</label>
                  <Select
                    value={form.defaultProvider}
                    onValueChange={(v) => setForm({ ...form, defaultProvider: v as "openai" | "gemini" })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI (ChatGPT)</SelectItem>
                      <SelectItem value="gemini">Google Gemini</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}
                {success && <p className="text-sm text-emerald-600">{success}</p>}

                <Button type="submit" className="w-full" disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save AI provider settings"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
