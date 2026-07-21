"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Building2, User as UserIcon, Plus } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface WorkspaceSummary {
  id: string;
  name: string;
  type: "PERSONAL" | "SHARED";
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
}

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await fetch("/api/workspaces", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load workspaces");
  return res.json();
}

async function switchWorkspace(workspaceId: string): Promise<{ activeWorkspaceId: string }> {
  const res = await fetch("/api/workspaces/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Could not switch workspace");
  return res.json();
}

export default function WorkspaceSelector({
  activeWorkspaceId,
  onCreateWorkspace,
}: {
  activeWorkspaceId: string;
  onCreateWorkspace?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: workspaces = [], isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });

  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: () => {
      // Every workspace-scoped query key should be invalidated on switch —
      // projects, tasks, members, etc. all depend on the active workspace.
      queryClient.invalidateQueries();
      setOpen(false);
    },
  });

  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  const personal = workspaces.filter((w) => w.type === "PERSONAL");
  const shared = workspaces.filter((w) => w.type === "SHARED");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-64 justify-between"
          disabled={isLoading}
        >
          <span className="flex items-center gap-2 truncate">
            {active?.type === "PERSONAL" ? (
              <UserIcon className="h-4 w-4 shrink-0" />
            ) : (
              <Building2 className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{active?.name ?? "Select workspace"}</span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search workspaces..." />
          <CommandList>
            <CommandEmpty>No workspace found.</CommandEmpty>

            <CommandGroup heading="Personal">
              {personal.map((ws) => (
                <WorkspaceItem
                  key={ws.id}
                  ws={ws}
                  isActive={ws.id === activeWorkspaceId}
                  onSelect={() => switchMutation.mutate(ws.id)}
                />
              ))}
            </CommandGroup>

            {shared.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Shared workspaces">
                  {shared.map((ws) => (
                    <WorkspaceItem
                      key={ws.id}
                      ws={ws}
                      isActive={ws.id === activeWorkspaceId}
                      onSelect={() => switchMutation.mutate(ws.id)}
                    />
                  ))}
                </CommandGroup>
              </>
            )}

            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  onCreateWorkspace?.();
                }}
                className="cursor-pointer"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create shared workspace
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function WorkspaceItem({
  ws,
  isActive,
  onSelect,
}: {
  ws: WorkspaceSummary;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={ws.name} onSelect={onSelect} className="cursor-pointer">
      {ws.type === "PERSONAL" ? (
        <UserIcon className="mr-2 h-4 w-4" />
      ) : (
        <Building2 className="mr-2 h-4 w-4" />
      )}
      <span className="flex-1 truncate">{ws.name}</span>
      <span className="mr-2 text-xs text-muted-foreground">{ws.role}</span>
      <Check className={cn("h-4 w-4", isActive ? "opacity-100" : "opacity-0")} />
    </CommandItem>
  );
}
