"use client";

/**
 * Persistent left-hand app navigation — dark blue gradient, distinct from
 * the project detail page's own light collapsible view-switcher sidebar
 * (Board/List/Gantt/...), which nests inside this one rather than replacing
 * it. Houses the workspace switcher, the three top-level destinations
 * (Dashboard, Clients, Engagements), the superadmin Admin menu (moved here
 * from dashboard-shell's header dropdown), and — per the same
 * relocation — the user's own profile link and Sign out button, so none of
 * that has to live in each page's own header anymore.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { LayoutDashboard, Building2, Briefcase, ShieldCheck, User as UserIcon, LogOut } from "lucide-react";
import WorkspaceSelector from "@/components/WorkspaceSelector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Building2 },
  { href: "/engagements", label: "Engagements", icon: Briefcase },
];

const ADMIN_LINKS = [
  { href: "/admin/permissions", label: "Permissions matrix" },
  { href: "/admin/custom-roles", label: "Custom roles" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/task-templates", label: "Task templates" },
  { href: "/admin/engagement-types", label: "Engagement types" },
  { href: "/admin/smtp-settings", label: "SMTP settings" },
  { href: "/admin/ai-provider-settings", label: "AI provider settings" },
];

export default function AppSidebar({
  activeWorkspaceId,
  userName,
  isSuperAdmin,
}: {
  activeWorkspaceId: string;
  userName: string;
  isSuperAdmin?: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-gradient-to-b from-[#0c1f45] via-[#132a55] to-[#1c3f75] text-white">
      <div className="p-3">
        <WorkspaceSelector activeWorkspaceId={activeWorkspaceId} />
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "border-l-gold bg-white/10 text-white"
                  : "border-l-transparent text-blue-100/80 hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}

        {isSuperAdmin && (
          <div className="pt-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md border-l-2 border-l-transparent px-3 py-2 text-left text-sm font-medium text-blue-100/80 transition-colors hover:bg-white/5 hover:text-white",
                    pathname.startsWith("/admin") && "border-l-gold bg-white/10 text-white"
                  )}
                >
                  <ShieldCheck className="h-4 w-4 shrink-0 text-gold" />
                  Admin
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                {ADMIN_LINKS.map((link) => (
                  <DropdownMenuItem key={link.href} asChild>
                    <Link href={link.href}>{link.label}</Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </nav>

      <div className="space-y-1 border-t border-white/10 p-3">
        <Link
          href="/profile"
          className={cn(
            "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-white/5 hover:text-white",
            pathname === "/profile" ? "bg-white/10 text-white" : "text-blue-100/80"
          )}
        >
          <UserIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{userName || "My profile"}</span>
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-blue-100/80 transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
