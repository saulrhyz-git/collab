"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2, Mail, User as UserIcon, Plus, Lock, Globe } from "lucide-react";
import CreateProjectDialog from "@/components/CreateProjectDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Engagement {
  id: string;
  name: string;
  description: string | null;
  visibility: "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS";
  createdAt: string;
}

interface ClientDetail {
  id: string;
  workspaceId: string;
  name: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  notes: string | null;
  engagements: Engagement[];
}

async function fetchClient(clientId: string): Promise<ClientDetail> {
  const res = await fetch(`/api/clients/${clientId}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load client");
  return res.json();
}

export default function ClientShell({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: client, isLoading, error } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => fetchClient(clientId),
  });

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to dashboard
        </Button>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-6 py-8">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error || !client ? (
          <p className="text-sm text-destructive">Couldn't load this client — you may not have access.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                  {client.name}
                </h1>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {client.primaryContactName && (
                    <span className="flex items-center gap-1">
                      <UserIcon className="h-3.5 w-3.5" />
                      {client.primaryContactName}
                    </span>
                  )}
                  {client.primaryContactEmail && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5" />
                      {client.primaryContactEmail}
                    </span>
                  )}
                </div>
              </div>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New engagement
              </Button>
            </div>

            {client.notes && (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">{client.notes}</CardContent>
              </Card>
            )}

            <div>
              <h2 className="mb-3 text-lg font-semibold">Engagements</h2>
              {client.engagements.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    No engagements yet for this client.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {client.engagements.map((p) => (
                    <Link key={p.id} href={`/projects/${p.id}`}>
                      <Card className="h-full transition-colors hover:bg-accent/50">
                        <CardContent className="p-4">
                          <div className="mb-1 flex items-center gap-2">
                            {p.visibility === "PRIVATE_TO_MEMBERS" ? (
                              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <h3 className="truncate font-medium">{p.name}</h3>
                          </div>
                          {p.description && (
                            <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <CreateProjectDialog
              workspaceId={client.workspaceId}
              open={createOpen}
              onOpenChange={setCreateOpen}
              defaultClientId={client.id}
            />
          </>
        )}
      </main>
    </div>
  );
}
