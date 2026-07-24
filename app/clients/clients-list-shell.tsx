"use client";

/**
 * Full client roster for the active workspace — filterable/sortable, one
 * row per client with a rollup of their engagements. Reuses the dashboard
 * aggregate endpoint for per-client engagement/task stats rather than
 * standing up a new backend query: services/dashboard.ts already computes
 * exactly this (grouped by client, task counts included) for the landing
 * page's "Clients & engagements" section. A client with zero visible
 * engagements simply won't appear in that grouping, so it's merged in here
 * with zeroed-out stats rather than dropped.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Building2, Plus, Search } from "lucide-react";
import CreateClientDialog from "@/components/CreateClientDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface ClientRow {
  id: string;
  name: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  createdAt: string;
}

interface DashboardClient {
  id: string;
  name: string;
  projects: { id: string; total: number; done: number; overdue: number }[];
}

interface DashboardData {
  clients: DashboardClient[];
}

async function fetchClients(workspaceId: string): Promise<ClientRow[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/clients`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load clients");
  return res.json();
}

async function fetchDashboard(workspaceId: string): Promise<DashboardData> {
  const res = await fetch(`/api/workspaces/${workspaceId}/dashboard`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load dashboard");
  return res.json();
}

type SortKey = "name" | "engagements" | "overdue" | "created";

export default function ClientsListShell({ activeWorkspaceId }: { activeWorkspaceId: string }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const { data: clients = [], isLoading: clientsLoading } = useQuery({
    queryKey: ["clients", activeWorkspaceId],
    queryFn: () => fetchClients(activeWorkspaceId),
  });
  const { data: dashboard, isLoading: dashboardLoading } = useQuery({
    queryKey: ["dashboard", activeWorkspaceId],
    queryFn: () => fetchDashboard(activeWorkspaceId),
  });

  const statsByClient = useMemo(() => {
    const map = new Map<string, { engagements: number; totalTasks: number; overdue: number }>();
    for (const c of dashboard?.clients ?? []) {
      map.set(c.id, {
        engagements: c.projects.length,
        totalTasks: c.projects.reduce((n, p) => n + p.total, 0),
        overdue: c.projects.reduce((n, p) => n + p.overdue, 0),
      });
    }
    return map;
  }, [dashboard]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    let filtered = clients.filter(
      (c) =>
        !term ||
        c.name.toLowerCase().includes(term) ||
        c.primaryContactName?.toLowerCase().includes(term) ||
        c.primaryContactEmail?.toLowerCase().includes(term)
    );

    const withStats = filtered.map((c) => ({
      ...c,
      stats: statsByClient.get(c.id) ?? { engagements: 0, totalTasks: 0, overdue: 0 },
    }));

    const dir = sortDir === "asc" ? 1 : -1;
    withStats.sort((a, b) => {
      switch (sortKey) {
        case "engagements":
          return (a.stats.engagements - b.stats.engagements) * dir;
        case "overdue":
          return (a.stats.overdue - b.stats.overdue) * dir;
        case "created":
          return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
        case "name":
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
    return withStats;
  }, [clients, statsByClient, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const isLoading = clientsLoading || dashboardLoading;

  return (
    <div className="flex min-h-screen flex-col bg-muted/20">
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              Clients
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Every client on record in this workspace.</p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New client
          </Button>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {clients.length === 0 ? "No clients yet." : "No clients match your search."}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b-2 border-b-gold bg-muted/40">
                    <SortHeader label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} />
                    <th className="px-4 py-2 text-left font-semibold">Primary contact</th>
                    <th className="px-4 py-2 text-left font-semibold">Email</th>
                    <SortHeader
                      label="Engagements"
                      align="center"
                      active={sortKey === "engagements"}
                      dir={sortDir}
                      onClick={() => toggleSort("engagements")}
                    />
                    <SortHeader
                      label="Overdue"
                      align="center"
                      active={sortKey === "overdue"}
                      dir={sortDir}
                      onClick={() => toggleSort("overdue")}
                    />
                    <SortHeader
                      label="Created"
                      active={sortKey === "created"}
                      dir={sortDir}
                      onClick={() => toggleSort("created")}
                    />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => router.push(`/clients/${c.id}`)}
                      className="cursor-pointer border-b last:border-b-0 hover:bg-accent/30"
                    >
                      <td className="px-4 py-2.5 font-medium">{c.name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{c.primaryContactName ?? "—"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{c.primaryContactEmail ?? "—"}</td>
                      <td className="px-4 py-2.5 text-center">{c.stats.engagements}</td>
                      <td
                        className={cn(
                          "px-4 py-2.5 text-center",
                          c.stats.overdue > 0 ? "font-medium text-destructive" : "text-muted-foreground"
                        )}
                      >
                        {c.stats.overdue}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {new Date(c.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>

      <CreateClientDialog workspaceId={activeWorkspaceId} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "center";
}) {
  return (
    <th className={cn("px-4 py-2 font-semibold", align === "center" ? "text-center" : "text-left")}>
      <button
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <ArrowUpDown className={cn("h-3 w-3", active && dir === "desc" && "rotate-180")} />
      </button>
    </th>
  );
}
