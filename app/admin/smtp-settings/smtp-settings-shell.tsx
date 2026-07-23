"use client";

/**
 * Superadmin-only SMTP configuration. The password field is always shown
 * blank — GET never returns the decrypted value (see
 * services/smtp-settings.ts) — with a placeholder indicating whether one
 * is already saved. Leaving it blank on save keeps the existing password;
 * there's no way to "view" it again once set, only replace or clear it.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface SmtpSettings {
  host: string | null;
  port: number;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  secure: boolean;
  hasPassword: boolean;
  updatedAt: string | null;
}

async function fetchSettings(): Promise<SmtpSettings> {
  const res = await fetch("/api/admin/smtp-settings", { credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to load SMTP settings");
  return res.json();
}

export default function SmtpSettingsShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    host: "",
    port: 587,
    username: "",
    password: "",
    fromAddress: "",
    fromName: "",
    secure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["admin-smtp-settings"],
    queryFn: fetchSettings,
  });

  useEffect(() => {
    if (!settings) return;
    setForm({
      host: settings.host ?? "",
      port: settings.port,
      username: settings.username ?? "",
      password: "",
      fromAddress: settings.fromAddress ?? "",
      fromName: settings.fromName ?? "",
      secure: settings.secure,
    });
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        host: form.host || null,
        port: form.port,
        username: form.username || null,
        fromAddress: form.fromAddress || null,
        fromName: form.fromName || null,
        secure: form.secure,
      };
      // Only send `password` if the admin actually typed something —
      // omitting the key keeps whatever's already saved.
      if (form.password !== "") body.password = form.password;

      const res = await fetch("/api/admin/smtp-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save SMTP settings");
      return res.json() as Promise<SmtpSettings>;
    },
    onSuccess: (updated) => {
      setError(null);
      setSuccess("SMTP settings saved.");
      setForm((f) => ({ ...f, password: "" }));
      queryClient.setQueryData(["admin-smtp-settings"], updated);
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
            <Mail className="h-5 w-5 text-muted-foreground" />
            SMTP settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Used to send invite emails. Leave blank to keep testing with the console-log fallback.
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Card>
            <CardContent className="p-4">
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  save.mutate();
                }}
              >
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Host</label>
                    <Input
                      placeholder="smtp.example.com"
                      value={form.host}
                      onChange={(e) => setForm({ ...form, host: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Port</label>
                    <Input
                      type="number"
                      value={form.port}
                      onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 587 })}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Username</label>
                  <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Password</label>
                  <Input
                    type="password"
                    placeholder={settings?.hasPassword ? "•••••••• (saved — leave blank to keep)" : "Not set"}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">From address</label>
                    <Input
                      type="email"
                      placeholder="noreply@example.com"
                      value={form.fromAddress}
                      onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">From name</label>
                    <Input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-gold"
                    checked={form.secure}
                    onChange={(e) => setForm({ ...form, secure: e.target.checked })}
                  />
                  Use TLS (typically port 465)
                </label>

                {error && <p className="text-sm text-destructive">{error}</p>}
                {success && <p className="text-sm text-emerald-600">{success}</p>}

                <Button type="submit" className="w-full" disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save SMTP settings"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
