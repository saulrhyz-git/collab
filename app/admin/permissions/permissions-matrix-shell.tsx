"use client";

/**
 * Superadmin-only RBAC matrix editor. Renders one grid per scope
 * (workspace-level roles across the top, project-level roles in a second
 * grid) with a row per permission key and a tickbox per (role, permission)
 * cell. Toggling a box PATCHes services/permissions.ts's setRolePermission,
 * which is the single write path — RLS's role_permissions_write policy
 * requires is_super_admin() independently, so even a forged request here
 * can't touch the table as anyone else.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Scope = "WORKSPACE" | "PROJECT";
type StorageScope = "WORKSPACE" | "PROJECT" | "CLIENT";

interface RoleGrant {
  role: string;
  label: string;
  /** What actually keys this cell's role_permissions row — see services/permissions.ts. */
  storageScope: StorageScope;
  isCustom: boolean;
  granted: boolean;
}

interface PermissionRow {
  key: string;
  label: string;
  scope: Scope;
  description: string | null;
  roles: RoleGrant[];
}

const SCOPE_LABEL: Record<Scope, string> = {
  WORKSPACE: "Workspace-level permissions",
  PROJECT: "Engagement-level permissions",
};

async function fetchMatrix(): Promise<PermissionRow[]> {
  const res = await fetch("/api/admin/permissions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load the permissions matrix");
  return res.json();
}

export default function PermissionsMatrixShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pendingCell, setPendingCell] = useState<string | null>(null);

  const { data: matrix, isLoading, error } = useQuery({
    queryKey: ["admin-permissions"],
    queryFn: fetchMatrix,
  });

  const toggle = useMutation({
    mutationFn: async (params: { scope: StorageScope; role: string; permissionKey: string; granted: boolean }) => {
      const res = await fetch("/api/admin/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update permission");
      }
      return res.json() as Promise<PermissionRow[]>;
    },
    onMutate: (params) => setPendingCell(`${params.scope}:${params.role}:${params.permissionKey}`),
    onSuccess: (updated) => queryClient.setQueryData(["admin-permissions"], updated),
    onSettled: () => setPendingCell(null),
  });

  const workspaceRows = matrix?.filter((r) => r.scope === "WORKSPACE") ?? [];
  const projectRows = matrix?.filter((r) => r.scope === "PROJECT") ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b-2 border-b-gold px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to dashboard
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-gold" />
          Super admin
        </span>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold">Permissions matrix</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tick a box to grant that role the permission; clear it to revoke. Changes take effect
            for every workspace/engagement immediately (within a short cache window).
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error || !matrix ? (
          <p className="text-sm text-destructive">Couldn't load the permissions matrix.</p>
        ) : (
          <Tabs defaultValue="WORKSPACE">
            <TabsList>
              <TabsTrigger value="WORKSPACE">Workspace</TabsTrigger>
              <TabsTrigger value="PROJECT">Engagement</TabsTrigger>
            </TabsList>
            <TabsContent value="WORKSPACE">
              <MatrixGrid
                scope="WORKSPACE"
                rows={workspaceRows}
                pendingCell={pendingCell}
                onToggle={(storageScope, role, permissionKey, granted) =>
                  toggle.mutate({ scope: storageScope, role, permissionKey, granted })
                }
              />
            </TabsContent>
            <TabsContent value="PROJECT">
              <p className="mb-2 text-xs text-muted-foreground">
                Columns in italics are superadmin-created custom roles (see{" "}
                <a href="/admin/custom-roles" className="underline">
                  Custom roles
                </a>
                ) — "(client-wide)" ones apply across every engagement under a client at once.
              </p>
              <MatrixGrid
                scope="PROJECT"
                rows={projectRows}
                pendingCell={pendingCell}
                onToggle={(storageScope, role, permissionKey, granted) =>
                  toggle.mutate({ scope: storageScope, role, permissionKey, granted })
                }
              />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}

function MatrixGrid({
  scope,
  rows,
  pendingCell,
  onToggle,
}: {
  scope: Scope;
  rows: PermissionRow[];
  pendingCell: string | null;
  onToggle: (storageScope: StorageScope, role: string, permissionKey: string, granted: boolean) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No {SCOPE_LABEL[scope].toLowerCase()} defined.
      </p>
    );
  }

  // Column set is the same for every row within a scope (built-ins plus
  // whatever custom roles exist for that scope), so the header can just
  // read it off the first row.
  const columns = rows[0].roles;

  return (
    <Card className="mt-3">
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-b-gold bg-muted/40">
              <th className="w-72 px-4 py-2 text-left font-semibold">Permission</th>
              {columns.map((col) => (
                <th
                  key={`${col.storageScope}:${col.role}`}
                  className={cn("px-3 py-2 text-center font-semibold", col.isCustom && "italic")}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-b-0 hover:bg-accent/30">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{row.label}</div>
                  {row.description && (
                    <div className="text-xs text-muted-foreground">{row.description}</div>
                  )}
                </td>
                {row.roles.map((cell) => {
                  const cellId = `${cell.storageScope}:${cell.role}:${row.key}`;
                  const isPending = pendingCell === cellId;
                  return (
                    <td key={`${cell.storageScope}:${cell.role}`} className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        className={cn(
                          "h-4 w-4 cursor-pointer accent-gold disabled:cursor-not-allowed disabled:opacity-50"
                        )}
                        checked={cell.granted}
                        disabled={isPending}
                        onChange={(e) => onToggle(cell.storageScope, cell.role, row.key, e.target.checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
