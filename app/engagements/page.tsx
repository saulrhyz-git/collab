import AppSidebar from "@/components/AppSidebar";
import { resolvePageContext } from "../../auth/page-context";
import EngagementsListShell from "./engagements-list-shell";

export default async function EngagementsPage() {
  const ctx = await resolvePageContext();

  return (
    <div className="flex min-h-screen">
      <AppSidebar activeWorkspaceId={ctx.activeWorkspaceId} userName={ctx.userName} isSuperAdmin={ctx.isSuperAdmin} />
      <div className="flex-1">
        <EngagementsListShell activeWorkspaceId={ctx.activeWorkspaceId} />
      </div>
    </div>
  );
}
