"use client";

/**
 * Flat, filterable/sortable roster of every engagement visible to the
 * caller in the active workspace — reuses the dashboard aggregate endpoint
 * (services/dashboard.ts) rather than a new query, flattening its
 * per-client buckets plus the client-less bucket into one table. Clicking
 * a row goes straight to that engagement's Board/List/Gantt page.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Briefcase, Globe, Lock, Plus, Search } from "lucide-react";
import CreateProjectDialog from "@/components/CreateProjectDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Visibility = "PUBLIC_TO_WORKSPACE" | "PRIVATE_TO_MEMBERS";

interface EngagementProject {
  id: string;
  name: string;
  visibility: Visibility;
  total: number;
  done: number;
  overdue: number;
}

interface DashboardData {
  clients: { id: string; name: string; projects: EngagementProject[] }[];
  unclientedProjects: EngagementProject[];
}

async function fetchDashboard(workspaceId: string): Promise<DashboardData> {
  const res = await fetch(`/api/workspaces/${workspaceId}/dashboard`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load engagements");
  return res.json();
}

type SortKey = "name" | "client" | "progress" | "overdue";

export default function EngagementsListShell({ activeWorkspaceId }: { activeWorkspaceId: string }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ["dashboard", activeWorkspaceId],
    queryFn: () => fetchDashboard(activeWorkspaceId),
  });

  const allEngagements = useMemo(() => {
    if (!dashboard) return [];
    const fromClients = dashboard.clients.flatMap((c) =>
      c.projects.map((p) => ({ ...p, clientId: c.id, clientName: c.name as string | null }))
    );
    const unclientedRows = dashboard.unclientedProjects.map((p) => ({ ...p, clientId: null, clientName: null as string | null }));
    return [...fromClients, ...unclientedRows];
  }, [dashboard]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = allEngagements.filter(
      (p) => !term || p.name.toLowerCase().includes(term) || p.clientName?.toLowerCase().includes(term)
    );

    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "client":
          return (a.clientName ?? "").localeCompare(b.clientName ?? "") * dir;
        case "progress": {
          const pctA = a.total > 0 ? a.done / a.total : 0;
          const pctB = b.total > 0 ? b.done / b.total : 0;
          return (pctA - pctB) * dir;
        }
        case "overdue":
          return (a.overdue - b.overdue) * dir;
        case "name":
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
    return sorted;
  }, [allEngagements, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/20">
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Briefcase className="h-5 w-5 text-muted-foreground" />
              Engagements
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Every engagement visible to you in this workspace.</p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New engagement
          </Button>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or client…"
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
              {allEngagements.length === 0 ? "No engagements yet." : "No engagements match your search."}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b-2 border-b-gold bg-muted/40">
                    <SortHeader label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} />
                    <SortHeader label="Client" active={sortKey === "client"} dir={sortDir} onClick={() => toggleSort("client")} />
                    <th className="px-3 py-2 text-center font-semibold">Visibility</th>
                    <SortHeader
                      label="Progress"
                      align="center"
                      active={sortKey === "progress"}
                      dir={sortDir}
                      onClick={() => toggleSort("progress")}
                    />
                    <SortHeader
                      label="Overdue"
                      align="center"
                      active={sortKey === "overdue"}
                      dir={sortDir}
                      onClick={() => toggleSort("overdue")}
                    />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => router.push(`/projects/${p.id}`)}
                        className="cursor-pointer border-b last:border-b-0 hover:bg-accent/30"
                      >
                        <td className="px-4 py-2.5 font-medium">{p.name}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{p.clientName ?? "—"}</td>
                        <td className="px-3 py-2.5 text-center">
                          {p.visibility === "PRIVATE_TO_MEMBERS" ? (
                            <Lock className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <Globe className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                            </div>
                            <Badge variant="secondary" className="text-[10px]">
                              {p.done}/{p.total}
                            </Badge>
                          </div>
                        </td>
                        <td
                          className={cn(
                            "px-4 py-2.5 text-center",
                            p.overdue > 0 ? "font-medium text-destructive" : "text-muted-foreground"
                          )}
                        >
                          {p.overdue}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>

      <CreateProjectDialog workspaceId={activeWorkspaceId} open={createOpen} onOpenChange={setCreateOpen} />
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
