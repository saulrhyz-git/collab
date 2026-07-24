import AppSidebar from "@/components/AppSidebar";
import { resolvePageContext } from "../../auth/page-context";
import ClientsListShell from "./clients-list-shell";

export default async function ClientsPage() {
  const ctx = await resolvePageContext();

  return (
    <div className="flex min-h-screen">
      <AppSidebar activeWorkspaceId={ctx.activeWorkspaceId} userName={ctx.userName} isSuperAdmin={ctx.isSuperAdmin} />
      <div className="flex-1">
        <ClientsListShell activeWorkspaceId={ctx.activeWorkspaceId} />
      </div>
    </div>
  );
}
